import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";

const requiredKeys = ["PI_LITELLM_BASE_URL", "PI_LITELLM_API_KEY", "AUTH_CLIENT_SECRET", "AUTH_SESSION_KEY"];
const options = {
  namespace: "agents",
  name: "webcontainer-env",
  context: undefined,
  envFile: fileURLToPath(new URL("../.env.local", import.meta.url)),
  update: false,
  dryRun: false,
};

function fail(message) {
  throw new Error(message);
}

function kubectl(args, input) {
  const result = spawnSync("kubectl", ["--context", options.context, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  // Never echo stderr or stdin: admission errors can include submitted values.
  if (result.error) fail("无法执行 kubectl，请检查安装、集群连接及超时情况。");
  if (result.status !== 0) fail(`kubectl 执行失败（退出码 ${result.status}），请检查当前集群、命名空间及权限。为保护密钥，未打印原始响应。`);
  return result.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--update") options.update = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--help") {
      console.log("用法：node scripts/sync-k8s-secret.mjs [--context 名称] [--namespace agents] [--name webcontainer-env] [--env-file 文件] [--dry-run] [--update]");
      console.log("默认仅从项目 .env.local 读取四个必要变量；不继承同名进程变量，不输出密钥值。已存在的 Secret 需显式 --update。仅支持安装 kubectl 的 macOS / Linux 环境。");
      return;
    } else {
      const field = { "--context": "context", "--namespace": "namespace", "--name": "name", "--env-file": "envFile" }[flag];
      if (!field || !args[i + 1] || args[i + 1].startsWith("--")) fail("参数无效，请使用 --help 查看用法。");
      options[field] = args[++i];
    }
  }
  const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
  if (options.namespace.length > 63 || !dnsLabel.test(options.namespace)) fail("命名空间格式无效。");
  if (options.name.length > 253 || !options.name.split(".").every(part => part.length <= 63 && dnsLabel.test(part))) fail("Secret 名称格式无效。");

  let env;
  try { env = parseEnv(await readFile(options.envFile, "utf8")); } catch { fail("无法读取或解析环境文件，请检查文件路径和格式。"); }
  const missing = requiredKeys.filter(key => !env[key]?.trim());
  if (missing.length) fail(`环境文件缺少必要变量：${missing.join("、")}。`);
  if (!/^[a-f0-9]{64}$/i.test(env.AUTH_SESSION_KEY)) fail("AUTH_SESSION_KEY 必须是 32 字节密钥对应的 64 位十六进制字符串。");
  try {
    const endpoint = new URL(env.PI_LITELLM_BASE_URL);
    if (!["http:", "https:"].includes(endpoint.protocol)) fail("invalid protocol");
  } catch { fail("PI_LITELLM_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址。"); }

  if (!options.context) {
    const result = spawnSync("kubectl", ["config", "current-context"], { encoding: "utf8", timeout: 10_000 });
    if (result.error || result.status !== 0 || !result.stdout.trim()) fail("无法获取当前 Kubernetes context，请先配置 kubectl。");
    options.context = result.stdout.trim();
  }
  console.log(`目标集群：${options.context}；命名空间：${options.namespace}；Secret：${options.name}`);
  console.log(`读取变量：${requiredKeys.join("、")}（不显示值）`);

  const metadata = kubectl(["get", "secret", options.name, "-n", options.namespace, "--ignore-not-found", "-o", 'jsonpath={.type}{"\\t"}{.metadata.resourceVersion}{"\\t"}{.metadata.labels.app\\.kubernetes\\.io/name}']);
  const stringData = Object.fromEntries(requiredKeys.map(key => [key, env[key]]));
  const dryRun = options.dryRun ? ["--dry-run=server"] : [];
  if (metadata) {
    const [type, resourceVersion, app] = metadata.split("\t");
    if (!options.update) fail("Secret 已存在，未作修改。如需更新这四个变量，请显式添加 --update。");
    if (type !== "Opaque" || (app && app !== "webcontainer")) fail("目标 Secret 的类型或用途不符，拒绝覆盖。");
    kubectl(["patch", "secret", options.name, "-n", options.namespace, "--type=merge", "--patch-file=/dev/stdin", ...dryRun, "-o", "name"],
      JSON.stringify({ metadata: { resourceVersion }, stringData }));
  } else {
    kubectl(["create", "-n", options.namespace, ...dryRun, "-f", "-", "-o", "name"], JSON.stringify({
      apiVersion: "v1", kind: "Secret", type: "Opaque",
      metadata: { name: options.name, namespace: options.namespace, labels: { "app.kubernetes.io/name": "webcontainer" } },
      stringData,
    }));
  }
  console.log(options.dryRun ? "服务端校验通过，未写入 Secret。" : "Secret 已写入，未输出或落盘保存密钥值。已有运行中的 Pod 需要重新启动才能读取更新后的环境变量。");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
