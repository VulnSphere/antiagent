# 1. Summary

The deepsec CLI executes code from a `deepsec.config.ts` (or `.mjs` / `.js` / `.cjs`) file that it discovers by walking up from the current working directory, before any command — including `--version` — is parsed, and before any of deepsec's agent sandboxing is initialized. Because deepsec's documented workflow is to run the CLI *inside* the repository being audited, an attacker-controlled repository can ship a config file whose top-level code executes with the privileges of whoever runs any deepsec command against that repository. We have verified end-to-end code execution as root using the official npm package (`deepsec@2.3.5`, installed globally).

# 2. Affected product and versions

- Product: deepsec CLI (`deepsec` on npm)
- Version tested: 2.3.5 (latest at the time of testing, 2026-08-17); the code path appears to have existed since the config loader was introduced, so earlier versions are likely affected as well.
- Platform verified: Linux x64, Node v26.7.0. The behavior is OS-independent.

# 3. Root cause

`packages/deepsec/src/cli.ts`, `main()`, line ~587:

  await applyAiGatewayDefaults();
  await loadConfig();          // <-- runs before program.parseAsync()
  ...

`packages/deepsec/src/load-config.ts`:

- `findConfigFile()` (lines 16–27) starts at `process.cwd()` and walks up parent directories looking for `deepsec.config.ts`, `deepsec.config.mjs`, `deepsec.config.js`, or `deepsec.config.cjs`. There is no trust check on *where* the file is found — in particular, no check that it was created by deepsec rather than by the repository under audit.
- On `loadConfig()` (lines 44–50), a `.ts` or `.cjs` config is executed via `createJiti(...).import(file)`; `.mjs` / `.js` configs are executed via native dynamic `import()`. Module top-level code runs with full privileges of the CLI process.
- The `catch` block (lines 51–61) only handles load errors after the fact; by then the payload has already executed.

Three properties compound into the vulnerability:

1. Execution precedes parsing: even `deepsec --version` triggers config execution.
2. Execution precedes every security mechanism: dotenv loading (see below), workspace scaffolding, agent sandboxing (OS sandboxes, tool allowlists, environment allowlists, and the Vercel Sandbox executor) all run later or never for early-exiting commands.
3. The documented usage pattern places the victim's cwd inside attacker-controlled content: the README's quick start is to run `deepsec init` from the root of the repository being scanned, and the `process --diff` PR workflow runs the CLI inside checkout of a PR's code in CI.

We recognize that deepsec's README states the tool is designed to run on trusted inputs, and that "a config file is code" is the established convention for TS-config tools (jest, vitest, tailwind). The reason We reporting this anyway is that the config search is rooted at `process.cwd()` with an upward directory walk, and deepsec's core use case is *running inside code that you do not trust* — including the PR-diff CI mode the project itself ships. In that setting, "the config in cwd" is attacker-supplied by construction, and the trust boundary the rest of the codebase carefully enforces (prompt-level instructions, tool allowlists, sandboxes, credential brokering) is bypassed before it is ever engaged.

# 4. Proof of concept (benign payload, verified)

PoC repository layout (`/root/targets/deepsec-rce-test`):

  deepsec.config.ts     <- payload + valid-looking default export

`deepsec.config.ts`:

  import { execSync } from "node:child_process";
  import fs from "node:fs";
  try {
    fs.writeFileSync("/tmp/deepsec-rce-proof-1-config.txt",
      `time=${new Date().toISOString()}\n` +
      `cwd=${process.cwd()}\n` +
      `user=${execSync("id").toString().trim()}\n` +
      `argv=${process.argv.join(" ")}\n`);
  } catch {}
  // Valid config shape so nothing looks wrong to the victim
  export default { projects: [{ id: "demo", root: "." }] };

Victim steps (verified with the globally installed official package):

  $ npm install -g deepsec
  $ cd /path/to/untrusted-repo     # contains the config above
  $ deepsec --version
  2.3.5
  $ cat /tmp/deepsec-rce-proof-1-config.txt
  time=2026-08-17T07:54:35.894Z
  cwd=/root/targets/deepsec-rce-test
  user=uid=0(root) gid=0(root) groups=0(root)
  argv=/usr/local/.../bin/node /usr/local/.../bin/deepsec --version

Arbitrary code executed as root from the least privileged possible command (`--version`). Replacing the marker payload with any other code (credential exfiltration, backdoor installation, cryptominer) is trivial and requires no further conditions.

# 5. Attack scenarios

- Local review of third-party code: a security researcher or engineer clones a repository they were asked to audit and runs `deepsec init` / `deepsec scan` from its root, per the README. Any deepsec command executes the repository's config.
- CI / PR automation (network-reachable impact): any workflow that runs deepsec on pull-request checkouts — e.g. `deepsec process --diff origin/main` as a CI gate, a pattern the tool explicitly supports — turns a pull request that adds a `deepsec.config.ts` into code execution inside the CI runner, with access to CI secrets (tokens, registries, cloud credentials). Because the config search walks up parent directories, placing the payload anywhere above the CLI's cwd also works.
- Amusingly, deepsec's own scanner flagged my malicious `deepsec.config.ts` as an `rce` candidate during `deepsec scan` — the scanner recognizes the pattern, but the loader executes it regardless.

# 6. Severity assessment

We assess this as Critical in the PR/CI scenario and High locally:

- CVSS 3.1 (CI scenario): AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H → 8.8 (attacker opens a PR; PR author is an unprivileged actor on the repository).
- CVSS 3.1 (local scenario): AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H → 7.8 (victim must run the CLI in the attacker's repository, which is the tool's advertised workflow).

Please treat these as my independent estimates; you are closer to the deployment reality.

# 7. Suggested remediation

In rough order of preference:

1. Restrict config discovery to locations deepsec itself controls: the `.deepsec/` workspace directory created by `init`, or an explicit `--config <path>` flag. Do not search upward from `process.cwd()`.
2. If repository-level configs must remain supported, refuse (or require an explicit, non-interactive-flag trust acknowledgment for) any config file that resides inside the root of the project being scanned, or that was not written by deepsec. In headless/CI mode (`--headless`/`--yes`, or `CI=true`), default to refusing repository-resident configs.
3. Consider a data-only config format (JSON/JSON5 with a schema, or a `defineConfig`-typed file that is parsed, not imported) so configuration cannot carry executable semantics; plugin/matcher registration could move into the workspace deepsec generates and pins.
4. As defense in depth, load the config *after* command parsing so non-config commands (`--version`, `status`, `report`, `export`, `metrics`) never execute config code at all.

