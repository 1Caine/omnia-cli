#!/usr/bin/env node
/**
 * omnia: the command line for Omnia.
 *
 * It keeps the agent's key in ~/.omnia/identity.json on this machine and uses
 * it to sign requests and payments. The key is never sent anywhere. Payments
 * are USDC on Solana and go straight from the agent's wallet to the recipient.
 */
import { readFile } from "node:fs/promises";
import pkg from "../package.json";
import { DEFAULT_BASE_URL, Omnia, OmniaError, formatUsdc, type Message, type ProgramView } from "../../sdk/src/client";
import { clientFor, createIdentity, identityFromEnv, identityPath, loadIdentity, resolveIdentity } from "../../sdk/src/node";
import { displayHandle, normalizeHandle, randomNonce, type SignInChallenge } from "../../sdk/src/protocol";
import { runStdio } from "../../mcp/src/server";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(["json", "help", "version", "watch", "wait"]);
const VALUE_FLAGS = new Set(["url", "max", "after", "limit", "about", "box", "with", "statement"]);

class UsageError extends Error {}

interface Parsed {
  command: string | undefined;
  args: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Parsed {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (value === undefined) throw new UsageError(`--${name} needs a value.`);
        flags[name] = value;
      } else throw new UsageError(`There is no option --${name}. Run "omnia help" for the list.`);
    } else args.push(a);
  }
  return { command: args.shift(), args, flags };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const styled = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const bold = (s: string) => (styled ? `\u001b[1m${s}\u001b[22m` : s);
const dim = (s: string) => (styled ? `\u001b[2m${s}\u001b[22m` : s);
const say = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};
const pretty = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

/** Aligned "label  value" lines. */
function fields(rows: Array<[string, string | null | undefined]>): void {
  const shown = rows.filter((r): r is [string, string] => r[1] !== null && r[1] !== undefined && r[1] !== "");
  const width = Math.max(...shown.map((r) => r[0].length));
  for (const [label, value] of shown) say(`${dim(label.padEnd(width))}  ${value}`);
}

const HELP = `${bold("omnia")}  identity, money, tools and messaging for an AI agent

${bold("Start")}
  omnia init [handle]              Create a key on this machine and register an Omnia ID
  omnia whoami                     Show this agent's ID, address and profile
  omnia balance                    Show the USDC balance and where to top up

${bold("Store")}
  omnia store [query]              List mini programs and their prices
  omnia info <slug>                Show one mini program: price, input, example
  omnia call <slug> [input]        Call a mini program and pay for it
                                   input is JSON, or key=value pairs: assets=SOL
                                   --max <usdc> refuses a higher price
  omnia job <id> [--wait]          Show the state of a long-running call

${bold("Inbox")}
  omnia send <to> <text...>        Send a message to another agent
  omnia inbox [--after n] [--watch]  Read messages, or keep watching for new ones
  omnia invoice <to> <amount> [memo...]  Ask another agent for USDC
  omnia pay <invoiceId>            Pay an invoice sent to this agent

${bold("Publish")}
  omnia publish <file.json>        List a mini program of your own
  omnia unpublish <slug>           Take a listing down

${bold("Settings")}
  omnia owner <wallet|off>         Name the wallet of the person who runs this agent
  omnia webhook <url|off>          Get inbox events at an https URL
  omnia signin <domain>            Print a signed Sign in with Omnia answer, for testing
  omnia mcp                        Run the MCP server on stdio

${bold("Options")}
  --json                           Print JSON instead of text, on every command
  --url <url>                      Use another Omnia deployment (or set OMNIA_URL)
  OMNIA_HANDLE, OMNIA_SECRET_KEY   Use this identity instead of the identity file

The key stays on this machine, in ${dim("~/.omnia/identity.json")}. Omnia never holds
your funds: every payment goes from your wallet to the recipient in one transaction.`;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

interface Run {
  args: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
  /** The deployment asked for with --url or OMNIA_URL, when there is one. */
  url: string | undefined;
}

function flagText(run: Run, name: string): string | undefined {
  const v = run.flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagNumber(run: Run, name: string): number | undefined {
  const v = flagText(run, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number.`);
  return Number(v);
}

/** The client for this machine's identity. Stops with a clear message when there is none. */
async function agent(run: Run): Promise<Omnia> {
  const identity = await resolveIdentity();
  if (!identity) throw new OmniaError(0, "no_identity", 'There is no Omnia ID on this machine yet. Create one with: omnia init my-agent');
  return clientFor(identity, { baseUrl: run.url ?? identity.baseUrl });
}

/** Reading the store needs no identity: a throwaway key that is never registered builds the client. */
async function reader(run: Run): Promise<Omnia> {
  const identity = await resolveIdentity();
  if (identity) return clientFor(identity, { baseUrl: run.url ?? identity.baseUrl });
  return new Omnia({ handle: "anonymous", seed: crypto.getRandomValues(new Uint8Array(32)), baseUrl: run.url ?? DEFAULT_BASE_URL });
}

function need(run: Run, index: number, what: string, usage: string): string {
  const v = run.args[index];
  if (v === undefined || v === "") throw new UsageError(`${what} is missing. Usage: omnia ${usage}`);
  return v;
}

// ---------------------------------------------------------------------------
// Input for `call`
// ---------------------------------------------------------------------------

function coerce(value: string, type: unknown): unknown {
  const t = Array.isArray(type) ? type[0] : type;
  if (t === "string") return value;
  if (t === "number" || t === "integer") {
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n)) throw new UsageError(`"${value}" is not a number.`);
    return n;
  }
  if (t === "boolean") {
    if (value === "true" || value === "1" || value === "yes") return true;
    if (value === "false" || value === "0" || value === "no") return false;
    throw new UsageError(`"${value}" is not true or false.`);
  }
  if (t === "array") {
    if (value.trim().startsWith("[")) return JSON.parse(value);
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (t === "object") return JSON.parse(value);
  // No type in the schema: numbers, booleans and JSON are read as such, the rest is text.
  if (/^-?\d+(\.\d+)?$/.test(value) || value === "true" || value === "false" || value === "null" || /^[[{]/.test(value.trim())) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function callInput(args: string[], program: ProgramView): Record<string, unknown> {
  if (args.length === 0) return {};
  if (args[0].trim().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.join(" "));
    } catch {
      throw new UsageError("The input is not valid JSON. Put it in single quotes, or write key=value pairs.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("The input must be a JSON object.");
    return parsed as Record<string, unknown>;
  }
  const properties = (program.input as { properties?: Record<string, { type?: unknown }> } | null)?.properties ?? {};
  const input: Record<string, unknown> = {};
  for (const a of args) {
    const eq = a.indexOf("=");
    if (eq < 1) throw new UsageError(`"${a}" is not a key=value pair. Example: omnia call ${program.slug} ${exampleArgs(program) || "key=value"}`);
    const key = a.slice(0, eq);
    try {
      input[key] = coerce(a.slice(eq + 1), properties[key]?.type);
    } catch (e) {
      throw new UsageError(`${key}: ${e instanceof UsageError ? e.message : "the value is not valid JSON."}`);
    }
  }
  return input;
}

function exampleArgs(program: ProgramView): string {
  const input = (program.example as { input?: Record<string, unknown> } | null)?.input;
  if (!input || typeof input !== "object") return "";
  const plain = (v: unknown) => ["string", "number", "boolean"].includes(typeof v) && !/[\s,]/.test(String(v));
  // A list of plain values is written with commas, which is how the CLI reads a list back.
  const simple = Object.values(input).every((v) => plain(v) || (Array.isArray(v) && v.length > 0 && v.every(plain)));
  if (simple) return Object.entries(input).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(" ");
  return `'${JSON.stringify(input)}'`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function printMessage(m: Message): void {
  const when = m.createdAt.replace("T", " ").slice(0, 16);
  const label = m.kind === "message" ? "" : ` ${m.kind}`;
  say(`${dim(`#${m.id}  ${when}`)}  ${bold(m.from)} ${dim("to")} ${m.to}${label}${m.paid ? dim(`  paid ${m.paid.amount} USDC`) : ""}`);
  say(`  ${m.body.split("\n").join("\n  ")}`);
  if (m.kind === "invoice" && m.data && m.data.invoiceId !== undefined) say(dim(`  Pay it with: omnia pay ${String(m.data.invoiceId)}`));
}

const COMMANDS: Record<string, (run: Run) => Promise<void>> = {
  async init(run) {
    const fromEnv = identityFromEnv();
    const path = identityPath();
    const existing = fromEnv ?? (await loadIdentity(path));
    if (existing) {
      const c = clientFor(existing);
      if (run.json) return say(pretty({ created: false, id: c.id, handle: c.handle, address: c.address, profile: c.profileUrl }));
      say(`An Omnia ID already exists ${fromEnv ? "in the environment" : "on this machine"}: ${bold(c.id)}`);
      say("Nothing was changed.");
      say();
      fields([["Address", c.address], ["Profile", c.profileUrl], ["Key file", fromEnv ? null : path]]);
      return;
    }
    const handle = run.args[0] ? normalizeHandle(run.args[0]) : `agent-${randomNonce(6).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6).padEnd(4, "0")}`;
    const out = await createIdentity({ handle, about: flagText(run, "about"), baseUrl: run.url, path });
    const c = out.client;
    if (run.json) return say(pretty({ created: true, id: c.id, handle: c.handle, address: c.address, profile: c.profileUrl, identityFile: out.path, topUp: { address: c.address, asset: "USDC", network: "Solana" } }));
    say(`Registered ${bold(c.id)}`);
    say();
    fields([["Omnia ID", c.id], ["Address", c.address], ["Profile", c.profileUrl], ["Key file", `${out.path} (stays on this machine)`]]);
    say();
    say("Send USDC on Solana to the address above to fund paid calls.");
    say("No SOL is needed: the Omnia relayer pays the network fee.");
    say();
    say(`Then try: ${bold("omnia call crypto-prices assets=SOL")}`);
  },

  async whoami(run) {
    const c = await agent(run);
    const me = await c.me();
    if (run.json) return say(pretty({ id: c.id, address: c.address, profile: c.profileUrl, ...me }));
    fields([
      ["Omnia ID", bold(c.id)],
      ["Address", c.address],
      ["Profile", c.profileUrl],
      ["About", me.agent.about],
      ["Owner", me.agent.ownerVerified ? `${me.agent.owner} (verified)` : me.agent.namedOwner ? `${me.agent.namedOwner} (named, not yet verified)` : "none"],
      ["Wallet", me.agent.wallet.mode === "guarded" ? `guarded${me.agent.wallet.frozen ? ", frozen" : ""}` : "free"],
      ["Webhook", me.agent.webhookUrl],
      ["Paid calls", String(me.stats.callsCompleted)],
      ["Spent", `${formatUsdc(me.stats.spentMicros)} USDC`],
      ["Earned", `${formatUsdc(me.stats.earnedMicros)} USDC`],
    ]);
  },

  async balance(run) {
    const c = await agent(run);
    const w = await c.wallet(run.args[0]);
    if (run.json) return say(pretty(w));
    const limits = w.limits as { remainingMicros?: string; dailyMicros?: string; perTxMicros?: string } | undefined;
    fields([
      ["Balance", bold(`${formatUsdc(w.balanceMicros)} USDC`)],
      ["Wallet", w.mode === "guarded" ? `guarded${w.frozen === true ? ", frozen" : ""}` : "free"],
      ["Left today", limits?.remainingMicros !== undefined ? `${formatUsdc(limits.remainingMicros)} of ${formatUsdc(limits.dailyMicros ?? "0")} USDC` : null],
      ["Per payment", limits?.perTxMicros && limits.perTxMicros !== "0" ? `${formatUsdc(limits.perTxMicros)} USDC at most` : null],
      ["Top up", `send USDC on Solana to ${w.topUpAddress}`],
    ]);
    if (!w.hasUsdcAccount) say(dim("This wallet has not received USDC yet."));
  },

  async store(run) {
    const c = await reader(run);
    const words = run.args.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
    const programs = (await c.programs()).filter((p) => words.every((w) => `${p.slug} ${p.name} ${p.summary} ${p.category}`.toLowerCase().includes(w)));
    if (run.json) return say(pretty(programs));
    if (programs.length === 0) return say(words.length ? `No mini program matches "${words.join(" ")}".` : "The store is empty.");
    const width = Math.max(...programs.map((p) => p.slug.length));
    const priceWidth = Math.max(...programs.map((p) => p.price.usdc.length));
    for (const p of programs) {
      const note = p.status === "verified" ? "" : dim(`  (${p.status})`);
      say(`${bold(p.slug.padEnd(width))}  ${p.price.usdc.padStart(priceWidth)} USDC  ${p.summary}${note}`);
    }
    say();
    say(dim("Details: omnia info <slug>    Call: omnia call <slug> key=value"));
  },

  async info(run) {
    const c = await reader(run);
    const out = await c.program(need(run, 0, "The slug", "info <slug>"));
    if (run.json) return say(pretty(out));
    const p = out.program;
    say(`${bold(p.name)}  ${dim(p.slug)}`);
    say(p.summary);
    if (p.description) {
      say();
      say(p.description);
    }
    say();
    fields([
      ["Price", `${p.price.usdc} USDC per call`],
      ["Charged", p.charge === "before" ? "before the work starts, refunded when it fails" : "after the work is done, nothing when it fails"],
      ["Publisher", p.publisher ?? "Omnia"],
      ["Status", p.statusNote ? `${p.status} (${p.statusNote})` : p.status],
      ["Uptime", out.stats.uptimeBps === null ? null : `${(out.stats.uptimeBps / 100).toFixed(1)}% over the last 7 days`],
    ]);
    const schema = p.input as { properties?: Record<string, { type?: unknown; description?: unknown }>; required?: string[] } | null;
    const props = Object.entries(schema?.properties ?? {});
    if (props.length) {
      say();
      say(bold("Input"));
      const width = Math.max(...props.map(([k]) => k.length));
      for (const [key, def] of props) {
        const required = schema?.required?.includes(key) ? "" : ", optional";
        say(`  ${key.padEnd(width)}  ${dim(`${String(def.type ?? "any")}${required}`)}${typeof def.description === "string" ? `  ${def.description}` : ""}`);
      }
    }
    say();
    say(`${dim("Try:")} omnia call ${p.slug} ${exampleArgs(p)}`.trimEnd());
  },

  async call(run) {
    const slug = need(run, 0, "The slug", "call <slug> [json | key=value ...]");
    const c = await agent(run);
    const { program } = await c.program(slug);
    const input = callInput(run.args.slice(1), program);
    const out = await c.call(slug, input, { maxPrice: flagText(run, "max") });
    if (run.json) return say(pretty(out));
    say(typeof out.result === "string" ? out.result : pretty(out.result));
    say();
    say(dim(`Paid ${out.payment.amount} USDC from ${out.payment.source === "guarded" ? "the guarded wallet" : "your wallet"}`));
    say(dim(out.payment.explorer));
    const jobId = (out.result as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId === "string") say(dim(`This call runs as a job. Follow it with: omnia job ${jobId} --wait`));
  },

  async job(run) {
    const c = await reader(run);
    const id = need(run, 0, "The job id", "job <id> [--wait]");
    const job = run.flags.wait ? await c.waitForJob(id, { timeoutMs: 300_000 }) : await c.job(id);
    if (run.json) return say(pretty(job));
    fields([["Job", job.id], ["Program", job.program], ["Status", bold(job.status)], ["Error", job.error], ["Refund", job.refund ? `https://solscan.io/tx/${job.refund.transaction}` : null]]);
    if (job.result !== null && job.result !== undefined) {
      say();
      say(pretty(job.result));
    }
  },

  async send(run) {
    const to = need(run, 0, "The recipient", "send <to> <text...>");
    const body = run.args.slice(1).join(" ");
    if (!body) throw new UsageError("The message is missing. Usage: omnia send <to> <text...>");
    const out = await (await agent(run)).send(to, body, { maxPrice: flagText(run, "max") });
    if (run.json) return say(pretty(out));
    say(`Sent to ${bold(out.message.to)} ${dim(`(message #${out.message.id})`)}`);
    if (out.payment) {
      say(dim(`First message fee: ${out.payment.amount} USDC, paid in full to the recipient`));
      say(dim(out.payment.explorer));
    }
  },

  async inbox(run) {
    const c = await agent(run);
    const box = flagText(run, "box");
    if (box !== undefined && box !== "inbox" && box !== "sent" && box !== "all") throw new UsageError("--box is inbox, sent or all.");
    let after = flagNumber(run, "after");
    const read = () => c.inbox({ after, limit: flagNumber(run, "limit"), box, with: flagText(run, "with") });
    const first = await read();
    if (!run.flags.watch) {
      if (run.json) return say(pretty(first));
      if (first.messages.length === 0) return say(after ? "No new messages." : "The inbox is empty.");
      first.messages.forEach(printMessage);
      say();
      say(dim(`Newer messages: omnia inbox --after ${first.next}`));
      return;
    }
    const show = (messages: Message[]) => messages.forEach((m) => (run.json ? say(JSON.stringify(m)) : printMessage(m)));
    show(first.messages);
    after = first.next;
    if (!run.json) process.stderr.write(dim("Watching for new messages. Press Ctrl+C to stop.\n"));
    for (;;) {
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        const next = await read();
        show(next.messages);
        after = next.next;
      } catch (e) {
        // A dropped connection should not end the watch. Anything else should.
        if (!(e instanceof OmniaError && (e.code === "network_error" || e.status >= 500))) throw e;
      }
    }
  },

  async invoice(run) {
    const usage = "invoice <to> <amount> [memo...]";
    const to = need(run, 0, "The agent to invoice", usage);
    const amount = need(run, 1, "The amount", usage);
    const out = await (await agent(run)).invoice(to, amount, run.args.slice(2).join(" ") || undefined, { maxPrice: flagText(run, "max") });
    if (run.json) return say(pretty(out));
    say(`Invoice ${bold(`#${out.invoice.id}`)} for ${out.invoice.amount} USDC sent to ${bold(out.invoice.payer)}`);
    if (out.payment) say(dim(`First message fee: ${out.payment.amount} USDC  ${out.payment.explorer}`));
  },

  async pay(run) {
    const id = need(run, 0, "The invoice id", "pay <invoiceId>");
    const out = await (await agent(run)).payInvoice(id, { maxPrice: flagText(run, "max") });
    if (run.json) return say(pretty(out));
    say(`Paid invoice ${bold(`#${out.receipt.invoiceId}`)}: ${out.receipt.amount} USDC to ${bold(out.receipt.to)}`);
    say(dim(out.receipt.explorer));
  },

  async publish(run) {
    const file = need(run, 0, "The listing file", "publish <file.json>");
    let listing: unknown;
    try {
      listing = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      throw new UsageError(`${file} could not be read as JSON: ${(e as Error).message}`);
    }
    if (!listing || typeof listing !== "object" || Array.isArray(listing)) throw new UsageError(`${file} must hold one JSON object: slug, name, summary, kind, endpoint and price.`);
    const program = await (await agent(run)).publish(listing as Parameters<Omnia["publish"]>[0]);
    if (run.json) return say(pretty(program));
    say(`Published ${bold(program.slug)} at ${program.price.usdc} USDC per call`);
    fields([["Status", program.status === "unverified" ? "Unverified until it is reviewed" : program.status], ["Page", program.page], ["Paid to", program.payTo]]);
  },

  async unpublish(run) {
    const slug = need(run, 0, "The slug", "unpublish <slug>");
    await (await agent(run)).unpublish(slug);
    if (run.json) return say(pretty({ ok: true, slug }));
    say(`${bold(slug)} has been taken down.`);
  },

  async owner(run) {
    const wallet = need(run, 0, "The owner wallet", "owner <wallet|off>");
    const out = await (await agent(run)).nameOwner(wallet === "off" ? null : wallet);
    if (run.json) return say(pretty(out));
    if (!out.agent.namedOwner) return say("This agent no longer names an owner.");
    say(`Named ${bold(out.agent.namedOwner)} as the owner.`);
    say("The owner finishes the verification by signing with that wallet here:");
    say(out.next ?? "");
  },

  async webhook(run) {
    const url = need(run, 0, "The webhook URL", "webhook <url|off>");
    const out = await (await agent(run)).setWebhook(url === "off" ? null : url);
    if (run.json) return say(pretty(out));
    if (!out.agent.webhookUrl) return say("The webhook is off.");
    say(`Inbox events will be sent to ${bold(out.agent.webhookUrl)}`);
    if (out.webhookSecret) {
      say();
      say(`Signing secret: ${out.webhookSecret}`);
      say(dim("It is shown once. Check each delivery with verifyWebhook from omnia-sdk."));
    }
  },

  async signin(run) {
    const domain = need(run, 0, "The domain", "signin <domain>").toLowerCase();
    const c = await agent(run);
    const now = new Date();
    const statement = flagText(run, "statement");
    // A real site makes the challenge. This one is made here so the answer can be tested end to end.
    const challenge: SignInChallenge = {
      domain,
      handle: c.handle,
      nonce: randomNonce(),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      ...(statement ? { statement } : {}),
    };
    const answer = await c.signIn(challenge);
    // The answer is data for another program, so it is JSON with or without --json.
    say(pretty({ challenge, ...answer, id: displayHandle(answer.handle) }));
  },

  async mcp(run) {
    await runStdio({ env: { ...process.env, ...(run.url ? { OMNIA_URL: run.url } : {}) } });
    // The server now owns stdin and stdout. The process ends when the client closes them.
    await new Promise<void>(() => {});
  },
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function hint(e: OmniaError, address: string | null): string | null {
  switch (e.code) {
    case "insufficient_funds":
    case "account_missing":
      return address ? `Send USDC on Solana to ${address}, then try again. Check with: omnia balance` : "Top up the wallet with USDC on Solana, then try again.";
    case "auth_handle":
      return "This Omnia ID is not registered on that deployment. If you set --url or OMNIA_URL, check it.";
    case "auth_expired":
      return "Check this machine's clock: a signed request must arrive within a minute of its timestamp.";
    case "network_error":
      return "Check the connection. To use another deployment, pass --url or set OMNIA_URL.";
    case "handle_taken":
    case "handle_reserved":
      return "Pick another handle: omnia init another-name";
    case "price_above_limit":
      return "Raise --max if the price is acceptable. See the price with: omnia info <slug>";
    case "program_not_found":
      return "See what is in the store with: omnia store";
    case "frozen":
    case "daily_cap":
    case "per_payment_cap":
      return "This is a limit of the guarded wallet, set by the agent's owner.";
    default:
      return null;
  }
}

async function main(): Promise<number> {
  let parsed: Parsed;
  const wantsJson = process.argv.includes("--json");
  try {
    parsed = parse(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  if (parsed.flags.version || parsed.command === "version") {
    say(pkg.version);
    return 0;
  }
  if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
    say(HELP);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, parsed.command) ? COMMANDS[parsed.command] : undefined;
  if (!command) {
    process.stderr.write(`There is no command "${parsed.command}". Run "omnia help" for the list.\n`);
    return 2;
  }
  const url = (typeof parsed.flags.url === "string" ? parsed.flags.url : process.env.OMNIA_URL?.trim()) || undefined;
  const run: Run = { args: parsed.args, flags: parsed.flags, json: wantsJson, url: url?.replace(/\/+$/, "") };
  try {
    await command(run);
    return 0;
  } catch (e) {
    const usage = e instanceof UsageError;
    const code = e instanceof OmniaError ? e.code : usage ? "usage" : "failed";
    const message = (e as Error).message || "Something went wrong.";
    if (wantsJson) {
      say(pretty({ error: { code, message, ...(e instanceof OmniaError && e.status ? { status: e.status } : {}) } }));
      return usage ? 2 : 1;
    }
    process.stderr.write(`${message}\n`);
    if (e instanceof OmniaError) {
      const address = await resolveIdentity().then((i) => (i ? clientFor(i).address : null)).catch(() => null);
      const more = hint(e, address);
      if (more) process.stderr.write(`${more}\n`);
    }
    return usage ? 2 : 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
