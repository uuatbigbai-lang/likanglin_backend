#!/usr/bin/env node
/**
 * 上传本地文件到微信云开发存储（CloudBase 云存储）。
 *
 * 支持两种鉴权方式（二选一，都放 backend/.env.cloud，已被 .gitignore 忽略）：
 *
 *   A. 云开发「API Key」（单个 token，云开发控制台 → API Key 管理页获取）：
 *        CLOUDBASE_API_KEY=eyJhbGciOi...
 *      走纯 HTTP API，零依赖。
 *
 *   B. 腾讯云 CAM 密钥对（SecretId + SecretKey，访问管理 → API 密钥管理获取）：
 *        TENCENTCLOUD_SECRET_ID=AKIDxxxx
 *        TENCENTCLOUD_SECRET_KEY=xxxx
 *      走 @cloudbase/node-sdk。
 *
 * 优先使用 A；A 不存在时使用 B。
 *
 * 用法：
 *   node scripts/upload-cloud-storage.js <文件或目录>... [--prefix contentMedia] [--env cloud1-1gr581cp70dbd77a] [--dry-run]
 *
 * 示例：
 *   node scripts/upload-cloud-storage.js ./media/gut-microbiome.png --prefix contentMedia/demo
 *   node scripts/upload-cloud-storage.js ./media --prefix contentMedia/demo --dry-run
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DEFAULT_ENV = 'cloud1-1gr581cp70dbd77a';
const DEFAULT_PREFIX = 'contentMedia';
const ENV_FILE = path.join(__dirname, '..', '.env.cloud');
const GATEWAY_HOST = 'api.tcloudbasegateway.com';

// ---------- 小工具 ----------
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) return;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && !(key in process.env)) process.env[key] = value;
    });
}

function printHelp() {
  console.log(`
上传本地文件到云开发存储（支持 API Key 或 SecretId/SecretKey 两种鉴权）

用法:
  node scripts/upload-cloud-storage.js <文件或目录>... [选项]

选项:
  --prefix <path>   云存储目标前缀，默认 ${DEFAULT_PREFIX}
  --env <envId>     云开发环境 ID，默认 ${DEFAULT_ENV}
  --dry-run         只打印将上传的文件清单，不真正上传

鉴权（放 backend/.env.cloud，已加入 .gitignore）:
  CLOUDBASE_API_KEY=...                # 方式 A：云开发 API Key
  TENCENTCLOUD_SECRET_ID=AKID...       # 方式 B：CAM 密钥对
  TENCENTCLOUD_SECRET_KEY=...
`);
}

function parseArgs(argv) {
  const args = { paths: [], prefix: DEFAULT_PREFIX, env: DEFAULT_ENV, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--prefix') args.prefix = argv[++i] || args.prefix;
    else if (item === '--env') args.env = argv[++i] || args.env;
    else if (item === '--dry-run') args.dryRun = true;
    else if (item === '--help' || item === '-h') { printHelp(); process.exit(0); }
    else if (!item.startsWith('--')) args.paths.push(item);
  }
  return args;
}

function collectFiles(inputPaths) {
  const results = [];
  const visit = (p) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      fs.readdirSync(p).forEach((name) => visit(path.join(p, name)));
    } else if (stat.isFile()) {
      if (path.basename(p).startsWith('.')) return;
      results.push(p);
    }
  };
  inputPaths.forEach((p) => {
    if (!fs.existsSync(p)) {
      console.warn(`⚠️  跳过不存在的路径: ${p}`);
      return;
    }
    visit(p);
  });
  return results;
}

const trimLeadingSlash = (value = '') => String(value).replace(/^\/+/, '');
const normalizeCloudPath = (prefix, filePath) => {
  const base = trimLeadingSlash(prefix);
  const relative = path.basename(filePath);
  return base ? `${base}/${relative}` : relative;
};

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
};

function contentTypeOf(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function httpRequest(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ statusCode: res.statusCode, body: buf, text: buf.toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- 方式 A：纯 HTTP（API Key） ----------
async function uploadViaHttp(apiKey, env, cloudPath, filePath) {
  const gateway = `https://${env}.${GATEWAY_HOST}`;

  // 第一步：获取上传授权信息
  const infoResp = await httpRequest('POST', `${gateway}/v1/storages/get-objects-upload-info`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify([{ objectId: cloudPath }]),
  });

  let info;
  try {
    info = JSON.parse(infoResp.text)[0];
  } catch (err) {
    throw new Error(`获取上传信息返回非 JSON（HTTP ${infoResp.statusCode}）：${infoResp.text.slice(0, 200)}`);
  }
  if (!info || info.code) {
    throw new Error(`获取上传信息失败（HTTP ${infoResp.statusCode}）：${info.code || ''} ${info.message || ''}`);
  }

  // 第二步：PUT 直传文件
  const fileBuf = fs.readFileSync(filePath);
  const putResp = await httpRequest('PUT', info.uploadUrl, {
    headers: {
      Authorization: info.authorization,
      'X-Cos-Security-Token': info.token,
      'X-Cos-Meta-Fileid': info.cloudObjectMeta,
      'Content-Type': contentTypeOf(filePath),
      'Content-Length': fileBuf.length,
    },
    body: fileBuf,
  });

  if (putResp.statusCode >= 300) {
    throw new Error(`上传失败（HTTP ${putResp.statusCode}）：${putResp.text.slice(0, 200)}`);
  }
  return info.cloudObjectId || '';
}

// ---------- 方式 B：SDK（SecretId + SecretKey） ----------
async function uploadViaSdk(secretId, secretKey, env, cloudPath, filePath) {
  let cloudbase;
  try {
    cloudbase = require('@cloudbase/node-sdk');
  } catch (err) {
    throw new Error('使用 SecretId/SecretKey 需要安装依赖，请先执行: npm install @cloudbase/node-sdk');
  }
  const app = cloudbase.init({ env, secretId, secretKey });
  const res = await app.uploadFile({
    cloudPath,
    fileContent: fs.createReadStream(filePath),
  });
  return res.fileID || '';
}

// ---------- 主流程 ----------
async function main() {
  loadEnvFile(ENV_FILE);
  const args = parseArgs(process.argv.slice(2));

  if (!args.paths.length) {
    printHelp();
    process.exit(1);
  }

  const apiKey = process.env.CLOUDBASE_API_KEY;
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;

  const files = collectFiles(args.paths);
  if (!files.length) {
    console.error('❌ 没有找到可上传的文件');
    process.exit(1);
  }

  const authMode = apiKey ? 'API Key (HTTP)' : secretId && secretKey ? 'SecretId/SecretKey (SDK)' : null;
  console.log(`\n环境 ID: ${args.env}`);
  console.log(`鉴权方式: ${authMode || '未配置'}`);
  console.log(`目标前缀: ${args.prefix}`);
  console.log(`待上传文件: ${files.length} 个\n`);
  files.forEach((f) => console.log(`  · ${f}  →  ${normalizeCloudPath(args.prefix, f)}`));

  if (args.dryRun) {
    console.log('\n(dry-run) 未执行上传。去掉 --dry-run 即可真正上传。');
    process.exit(0);
  }

  if (!authMode) {
    console.error(`\n❌ 缺少鉴权配置。请创建 ${ENV_FILE} 并写入（二选一）：`);
    console.error('   方式 A：CLOUDBASE_API_KEY=...          （云开发控制台 → API Key 管理页）');
    console.error('   方式 B：TENCENTCLOUD_SECRET_ID=AKID...  （访问管理 → API 密钥管理）');
    console.error('           TENCENTCLOUD_SECRET_KEY=...');
    process.exit(1);
  }

  const uploadOne = (filePath) => {
    const cloudPath = normalizeCloudPath(args.prefix, filePath);
    return apiKey
      ? uploadViaHttp(apiKey, args.env, cloudPath, filePath)
      : uploadViaSdk(secretId, secretKey, args.env, cloudPath, filePath);
  };

  const results = [];
  for (const filePath of files) {
    try {
      const fileID = await uploadOne(filePath);
      results.push({ ok: true, filePath, cloudPath: normalizeCloudPath(args.prefix, filePath), fileID });
      console.log(`✅ ${filePath}  →  ${fileID}`);
    } catch (err) {
      results.push({ ok: false, filePath, cloudPath: normalizeCloudPath(args.prefix, filePath), error: err.message });
      console.error(`❌ ${filePath} 上传失败: ${err.message}`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n完成: 成功 ${okCount} / ${results.length}`);
  if (okCount) {
    console.log('\n内容页配置时，mediaUrl 可填这些相对路径（后端会自动补 contentMedia/ 前缀）：');
    results.filter((r) => r.ok).forEach((r) => {
      console.log(`  ${r.cloudPath.replace(/^contentMedia\//, '')}`);
    });
  }
}

main().catch((err) => {
  console.error('\n❌ 执行出错:', err);
  process.exit(1);
});
