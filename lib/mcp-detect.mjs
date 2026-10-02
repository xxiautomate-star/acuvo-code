/**
 * ── ⭐⭐⭐ THE BLOCKER WAS NEVER THE CAPABILITY. IT WAS HAND-AUTHORED JSON. ───
 *
 * `mcp.mjs`, `mcp-add.mjs`, `mcp-consent.mjs`, `mcp-search.mjs`,
 * `mcp-server.mjs` and a 19-entry curated catalogue all exist and are tested by
 * sixteen files. And MCP has reached **one build, ever** — one server
 * (`deepwiki`), disconnected four seconds later.
 *
 * ⚠️ THE REASON IS THAT NOTHING EVER SUGGESTS ONE. A person has to know that
 * MCP exists, know which server answers their problem, know its npm name, and
 * write a JSON block before anything happens. Every one of those is a place to
 * stop, and the catalogue's own value — knowing which server is the right one —
 * is locked behind the step nobody takes.
 *
 * ⭐ SO THIS READS THE PROJECT AND SAYS WHAT WOULD HAVE HELPED. It is the same
 * argument as `dropped.mjs` (the capability was never the missing part) and the
 * same shape as `rewrite-waste.mjs`: not advice, but a named fact — *"you have
 * a `playwright.config.ts`"* — attached to the one server that answers it.
 *
 * ── ⚠️ THREE RULES IT MUST NOT BREAK ────────────────────────────────────────
 *
 * 1. **Only ever suggest a VERIFIED entry.** The catalogue marks unverified
 *    servers `verified: false` and they are INERT — they can never be enabled.
 *    Suggesting one would send a person to a door that does not open. Measured
 *    2026-08-28: 16 of 19 are verified, and the three that are not are
 *    `github`, `postgres` and `github_remote`. ⭐ Which is why a database signal
 *    points at **`dbhub`** — it is verified and speaks Postgres — and never at
 *    `postgres`, which is not.
 *
 * 2. **No tree walk.** A fixed list of root filenames and one `package.json`
 *    parse. A recursive scan on every session start is a tax on every run,
 *    including the overwhelming majority with nothing to find.
 *
 * 3. **It never connects anything.** `mcp-consent.mjs` exists because booting a
 *    server is a trust decision — it runs someone else's code, or sends the
 *    workspace's text to someone else's host. The register's wording was "boot
 *    a Postgres/browser MCP silently"; silence is exactly what consent forbids.
 *    This returns a suggestion for a HUMAN, and adds nothing to the model's
 *    prompt or tool offer — so it also cannot touch the builder's byte ceiling.
 *
 * Pure: all filesystem access is injected, so the whole detector is testable
 * without a disk.
 */

/**
 * The signals, each naming the ONE verified server that answers it.
 *
 * ⚠️ `why` is written for the person reading a terminal, and it names the
 * EVIDENCE rather than the category. "You have a playwright.config.ts" is a
 * fact; "this looks like a testing project" is a guess wearing a sentence.
 */
const SIGNALS = Object.freeze([
  {
    server: 'dbhub',
    files: ['docker-compose.yml', 'docker-compose.yaml', 'supabase/config.toml', 'prisma/schema.prisma'],
    filePattern: /postgres|mysql|mariadb|mssql/i,
    deps: ['pg', 'postgres', 'mysql2', 'prisma', '@prisma/client', 'drizzle-orm', 'knex', '@supabase/supabase-js'],
    envKeys: ['DATABASE_URL', 'POSTGRES_URL', 'PGHOST', 'MYSQL_URL'],
    why: 'run SQL and read the schema directly instead of guessing at table shapes',
  },
  {
    server: 'playwright',
    files: ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'],
    deps: ['@playwright/test', 'playwright'],
    why: 'drive the same browser your tests already use',
  },
  {
    server: 'browser',
    deps: ['puppeteer', 'puppeteer-core'],
    why: 'drive a real Chrome — click, fill, screenshot, read the console',
  },
  {
    server: 'svelte',
    files: ['svelte.config.js', 'svelte.config.ts'],
    deps: ['svelte', '@sveltejs/kit'],
    why: 'compile a snippet and get Svelte\'s own compiler errors back',
  },
  {
    server: 'astro',
    files: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'],
    deps: ['astro'],
    why: 'search Astro\'s own documentation instead of recalling it',
  },
  {
    server: 'cloudflare',
    files: ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'],
    deps: ['wrangler', '@cloudflare/workers-types'],
    why: 'Workers, KV, D1 and R2 documentation, version-correct',
  },
  {
    server: 'awsdocs',
    files: ['serverless.yml', 'template.yaml', 'samconfig.toml'],
    depPrefixes: ['@aws-sdk/'],
    deps: ['aws-sdk', 'aws-cdk-lib'],
    why: 'AWS docs, and which services actually exist in a region',
  },
  {
    server: 'huggingface',
    files: ['requirements.txt', 'pyproject.toml'],
    filePattern: /transformers|huggingface_hub|diffusers|sentence-transformers/i,
    deps: ['@huggingface/inference', '@huggingface/hub'],
    why: 'search models, datasets and Spaces, and read a repo card',
  },
  /**
   * ── ⭐ ADDED 2026-08-29 WITH THEIR CATALOGUE ENTRIES, IN THE SAME CHANGE ────
   *
   * Both are first-party, keyless, proven with a real tool call AND with five
   * consecutive connects (see the sweep note in `mcp-defaults.mjs`). They are
   * narrow on purpose — a signal that fires on projects with no use for the
   * server is how a suggestion becomes noise and stops being read.
   *
   * ⚠️ A THIRD SIGNAL (`chakra`) WAS WRITTEN HERE AND REMOVED. Its server is a
   * NAMED REJECTION in the catalogue for losing its own sessions, and
   * `detectServers` would have skipped it anyway: the `verified` rule is
   * enforced against the real catalogue, not against this list. That is the rule
   * working as designed, and it is why the rule is enforced there rather than by
   * whoever edits this array remembering.
   */
  {
    server: 'convex',
    files: ['convex.json'],
    deps: ['convex'],
    depPrefixes: ['@convex-dev/'],
    why: 'Convex\'s own schema, index and scaling guidance rather than a guess at its API',
  },
  {
    server: 'clerk',
    depPrefixes: ['@clerk/'],
    envKeys: ['CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'],
    why: 'Clerk\'s current auth snippets, so the integration matches the SDK you actually have',
  },
  /**
   * ── ⭐ ADDED 2026-09-19: THE MICROSOFT STACK HAD NO SIGNAL AT ALL ──────────
   *
   * `mslearn` is first-party (`learn.microsoft.com/api/mcp`), keyless, and was
   * verified by a real call on 2026-08-25 and again on 2026-09-19 — 670ms to
   * connect, 20,609 characters of real Azure Functions documentation back. It
   * has been in the catalogue for 25 days and nothing has ever pointed anybody
   * at it, which is the exact failure this whole module was written to fix.
   *
   * ⚠️ NARROW ON PURPOSE. `azure-pipelines.yml` was weighed and LEFT OUT: a
   * JavaScript shop can run its CI on Azure DevOps and never write a line of
   * .NET, and a signal that fires on projects with no use for the server is how
   * a suggestion becomes noise. `global.json` pins a .NET SDK and `host.json`
   * with an `extensionBundle` is an Azure Functions app; neither is ambiguous.
   */
  {
    server: 'mslearn',
    files: ['global.json', 'host.json'],
    filePattern: /extensionBundle|"sdk"|functionTimeout/,
    deps: ['@azure/functions', 'azure-functions-core-tools'],
    depPrefixes: ['@azure/'],
    envKeys: ['AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID', 'AzureWebJobsStorage'],
    why: 'Microsoft\'s own docs for Azure, .NET and TypeScript instead of a recollection of them',
  },
  /**
   * ── ⭐⭐⭐ LAST, AND IT IS THE ONE THAT ANSWERS EVERY PROJECT ───────────────
   *
   * Every signal above is EVIDENCE OF A STACK. `docs` (Context7) is evidence of
   * a DEPENDENCY, which is a different and much commoner thing: the single most
   * common way a generated file is wrong is a correct answer for a version
   * nobody is running, and a declared dependency is exactly the place that
   * happens. The catalogue's own register called it "the single biggest quality
   * lever on generated code" and nothing has ever suggested it.
   *
   * ⚠️ THE ORDER IS THE DESIGN, NOT AN ACCIDENT. `detectionNote` shows the FIRST
   * TWO, so a project with a real stack signal still hears about its stack; this
   * one surfaces on the projects that would otherwise be told nothing at all.
   * Measured 2026-09-19 over nine repositories in this tree: 3 of 9 got no
   * suggestion whatsoever, `acuvo-code` itself among them.
   *
   * ⚠️ AND IT MUST NOT FIRE ON A PROJECT WITH NO DEPENDENCIES, because then the
   * evidence sentence would be false. `acuvo-code` declares none, so it still
   * hears nothing — which is correct, and is why the count is in the evidence.
   */
  {
    server: 'docs',
    anyDependency: true,
    why: 'the CURRENT API of the libraries you actually installed, source-cited, instead of one recalled from training',
  },
]);

/** Every dependency name a manifest declares, in one flat list. */
function dependenciesOf(manifestText) {
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const out = [];
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = parsed[key];
    if (block && typeof block === 'object') out.push(...Object.keys(block));
  }
  return out;
}

/**
 * Which verified MCP servers this project gives evidence for.
 *
 * @param {object} io  `{ exists(path), read(path) }` — both may throw or return
 *   null for anything unreadable; an unreadable file is simply no evidence.
 * @param {object} opts
 * @param {readonly string[]} opts.already  server names already configured, so a
 *   suggestion is never made for something the person has already added.
 * @param {(name:string)=>object|null} opts.entryFor  the catalogue lookup, so
 *   the `verified` rule is enforced against the real catalogue rather than
 *   against a copy of it that can drift.
 * @returns {Array<{server:string, why:string, evidence:string}>}
 */
export function detectServers(io, { already = [], entryFor = null } = {}) {
  const have = new Set((already ?? []).map((n) => String(n).toLowerCase()));
  /**
   * ⚠️ MEMOISED, AND THE TEST THAT COUNTS READS IS WHY. Without this the env
   * scan re-read `.env` and `.env.local` once per candidate key — **9 reads on
   * an EMPTY project**, on every session start. The signals are declarative and
   * will grow; the read has to be bounded by construction rather than by
   * whoever adds the ninth signal remembering.
   */
  const seen = new Map();
  const read = (p) => {
    if (seen.has(p)) return seen.get(p);
    let out = null;
    try {
      const v = io?.read?.(p);
      out = typeof v === 'string' ? v : null;
    } catch { out = null; }
    seen.set(p, out);
    return out;
  };
  const exists = (p) => {
    try { return io?.exists?.(p) === true; } catch { return false; }
  };

  /**
   * ⚠️ READ ONCE. Eight signals each asking for `package.json` is eight reads of
   * the same file on every session start.
   */
  const manifest = read('package.json');
  const deps = manifest ? dependenciesOf(manifest) : [];
  const depSet = new Set(deps);

  const found = [];
  for (const signal of SIGNALS) {
    if (have.has(signal.server)) continue;

    /**
     * ⚠️ THE VERIFIED RULE, ENFORCED AGAINST THE REAL CATALOGUE. An unverified
     * entry is inert and can never be enabled, so suggesting it sends a person
     * to a door that does not open.
     */
    if (typeof entryFor === 'function') {
      const entry = entryFor(signal.server);
      if (!entry || entry.verified !== true) continue;
    }

    let evidence = null;

    for (const dep of signal.deps ?? []) {
      if (depSet.has(dep)) { evidence = `package.json depends on ${dep}`; break; }
    }
    if (!evidence) {
      for (const prefix of signal.depPrefixes ?? []) {
        const hit = deps.find((d) => d.startsWith(prefix));
        if (hit) { evidence = `package.json depends on ${hit}`; break; }
      }
    }
    if (!evidence) {
      for (const file of signal.files ?? []) {
        if (!exists(file)) continue;
        /**
         * ⚠️ A FILE THAT MUST ALSO SAY SOMETHING. A `docker-compose.yml` is not
         * evidence of a database; a `docker-compose.yml` containing `postgres`
         * is. Without the pattern this would suggest `dbhub` to every project
         * that has ever containerised anything.
         */
        if (signal.filePattern) {
          const body = read(file);
          /**
           * ⚠️ THE WORD THAT ACTUALLY MATCHED, NOT THE FIRST ALTERNATIVE.
           * This read `signal.filePattern.source.split('|')[0]`, so a
           * `global.json` matching `"sdk"` was reported as *"global.json
           * mentions extensionBundle"* — a sentence naming a string that is
           * not in the file. Every other line in this module names the
           * evidence rather than the category; an evidence line that is
           * simply false is worse than a category, because it is checkable
           * and it fails the check.
           */
          const hit = signal.filePattern.exec(body ?? '');
          if (!body || !hit) continue;
          evidence = `${file} mentions ${hit[0]}`;
        } else {
          evidence = `${file} is in this project`;
        }
        break;
      }
    }
    /**
     * ⚠️ THE COUNT IS THE EVIDENCE, AND THAT IS WHY IT IS A COUNT. "You have
     * dependencies" is a category; "package.json declares 27 dependencies" is a
     * fact the reader can check in the file they already have open. Zero
     * dependencies is no evidence at all, so this stays silent rather than
     * suggesting a documentation server to a project with nothing to document.
     */
    if (!evidence && signal.anyDependency === true && deps.length > 0) {
      evidence = `package.json declares ${deps.length} ${deps.length === 1 ? 'dependency' : 'dependencies'}`;
    }
    if (!evidence) {
      for (const key of signal.envKeys ?? []) {
        const body = read('.env') ?? read('.env.local');
        if (body && new RegExp(`^\\s*${key}\\s*=`, 'm').test(body)) {
          /**
           * ⚠️ THE KEY'S NAME ONLY, NEVER ITS VALUE. A connection string is a
           * credential, and this sentence is printed to a terminal and may be
           * pasted into an issue.
           */
          evidence = `${key} is set in your .env`;
          break;
        }
      }
    }

    if (evidence) found.push({ server: signal.server, why: signal.why, evidence });
  }
  return found;
}

/**
 * ── ⭐⭐⭐ THE NAMES ALREADY CONFIGURED — AND WHY THIS IS A FUNCTION ─────────
 *
 * `detectServers` takes `already` and skips anything in it, and its unit tests
 * prove that works when handed `['playwright']`. The CALLER got the shape wrong,
 * which no unit test of either side could see:
 *
 *     bin/acuvo.mjs:  Object.keys(readMcpConfig(root)?.servers ?? {})
 *
 * ⚠️ `readMcpConfig().servers` IS AN ARRAY OF `{name, …}` OBJECTS, not a map
 * keyed by name. `Object.keys` on an array returns its INDICES — measured
 * 2026-08-29 on a real config holding one server: `["0"]`. So `already` could
 * never contain a server name, and the suggestion for a server the user had
 * ALREADY ADDED printed on every run, for ever. Reproduced end to end: `acuvo
 * mcp add convex`, then the very next run still said *"MCP servers that fit this
 * project: · convex …"*.
 *
 * ⭐ THAT IS THE WHOLE FEATURE FAILING AT ITS ONE JOB. This detector exists
 * because nothing ever suggested a server; a suggestion that does not stop after
 * you act on it is how a person learns to stop reading the line — and the line
 * is the only thing standing between a shipped MCP client and nobody using it.
 *
 * ⚠️ SO IT IS A FUNCTION, NOT AN INLINE EXPRESSION, and it takes the whole
 * config object rather than the array. The bug was a shape assumption made in a
 * file with no test; the fix is for the shape to be owned by one place that has
 * one, pinned against what `readMcpConfig` really returns.
 *
 * @param {{ok?:boolean, servers?:Array<{name?:string}>}|null} cfg
 * @returns {string[]}
 */
export function configuredServerNames(cfg) {
  const servers = cfg?.servers;
  if (!Array.isArray(servers)) return [];
  return servers
    .map((s) => (typeof s?.name === 'string' ? s.name : null))
    .filter((n) => typeof n === 'string' && n.length > 0);
}

/**
 * The line a person reads, or null when there is nothing worth saying.
 *
 * ⚠️ CAPPED AT TWO. A wall of suggestions is ignored exactly like an empty one,
 * and the point is that a person adds ONE server and sees what it does.
 */
export function detectionNote(found) {
  if (!Array.isArray(found) || found.length === 0) return null;
  const show = found.slice(0, 2);
  const lines = show.map((f) => `  · ${f.server} — ${f.why} (${f.evidence})`);
  const more = found.length > show.length ? `\n  … and ${found.length - show.length} more — see \`acuvo mcp list\`.` : '';
  return `MCP servers that fit this project:\n${lines.join('\n')}${more}\n`
    + `  Add one with \`acuvo mcp add ${show[0].server}\`. Nothing runs until you do.`;
}
