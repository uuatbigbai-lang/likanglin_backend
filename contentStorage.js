/**
 * 内容页媒体文件存储工具。
 * 上传图片 / PDF / 视频到云开发（CloudBase）存储的 contentMedia/ 目录，
 * 供后台 dashboard?page=content 页面直接上传媒体文件使用。
 *
 * 鉴权方式（优先级从高到低）：
 *   A. CLOUDBASE_API_KEY —— 云开发「API Key」，走纯 HTTP API（零依赖）。
 *   B. TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY —— 腾讯云 CAM 密钥，走 @cloudbase/node-sdk。
 *   C. 云托管运行时注入的临时凭证 —— @cloudbase/node-sdk 自动读取。
 *
 * 密钥可放在 backend/.env.cloud（已被 .gitignore 忽略），本模块会作为兜底加载。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const ENV_FILE = path.join(__dirname, '.env.cloud');
const GATEWAY_HOST = 'api.tcloudbasegateway.com';

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

// 允许上传的扩展名（对应内容块 image/video/pdf 三种媒体类型）
const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_BY_EXT));

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

// 从 CLOUD_STORAGE_BASE（cloud://<envId>.<bucket>）解析云开发环境 ID
function resolveEnvId() {
  const base = String(process.env.CLOUD_STORAGE_BASE || '');
  const match = base.match(/^cloud:\/\/([^.]+)\./);
  return match ? match[1] : (process.env.CLOUDBASE_ENV_ID || 'cloud1-1gr581cp70dbd77a');
}

function contentTypeOf(filename, fallback) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  return fallback || 'application/octet-stream';
}

function sanitizeFileName(filename) {
  const base = path.basename(String(filename || 'file'));
  const ext = path.extname(base).toLowerCase();
  const stem = path.basename(base, ext).replace(/[^\w.-]+/g, '_').slice(0, 64);
  return `${stem || 'file'}${ext}`;
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

// 方式 A：纯 HTTP（API Key）
async function uploadViaHttp(apiKey, env, cloudPath, buffer, contentType) {
  const gateway = `https://${env}.${GATEWAY_HOST}`;

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
    throw new Error(`获取上传信息失败（HTTP ${infoResp.statusCode}）：${info?.code || ''} ${info?.message || ''}`);
  }

  const putResp = await httpRequest('PUT', info.uploadUrl, {
    headers: {
      Authorization: info.authorization,
      'X-Cos-Security-Token': info.token,
      'X-Cos-Meta-Fileid': info.cloudObjectMeta,
      'Content-Type': contentType,
      'Content-Length': buffer.length,
    },
    body: buffer,
  });

  if (putResp.statusCode >= 300) {
    throw new Error(`上传失败（HTTP ${putResp.statusCode}）：${putResp.text.slice(0, 200)}`);
  }
  return info.cloudObjectId || '';
}

function initCloudBase(env) {
  let cloudbase;
  try {
    cloudbase = require('@cloudbase/node-sdk');
  } catch (err) {
    throw new Error('使用云存储上传需要依赖 @cloudbase/node-sdk，请先执行: npm install @cloudbase/node-sdk');
  }
  const secretId = process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY;
  return secretId && secretKey ? cloudbase.init({ env, secretId, secretKey }) : cloudbase.init({ env });
}

/**
 * 上传媒体文件到云存储 contentMedia/ 目录。
 * @param {Buffer} buffer 文件二进制内容
 * @param {object} options
 * @param {string} options.filename 原始文件名（用于判定扩展名/类型）
 * @param {string} [options.contentType] 兜底 Content-Type
 * @param {string} [options.dir] 可选的子目录（相对 contentMedia/）
 * @returns {{ fileID: string, mediaUrl: string, cloudPath: string, contentType: string, filename: string, size: number }}
 */
async function uploadContentMedia(buffer, { filename, contentType, dir = '' } = {}) {
  loadEnvFile(ENV_FILE);

  const originalName = String(filename || 'file');
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`不支持的文件类型：${ext || '未知'}（仅支持图片 png/jpg/jpeg/gif/webp/svg、视频 mp4/mov、PDF）`);
  }

  const safeName = sanitizeFileName(originalName);
  const finalName = `${path.basename(safeName, ext)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const subPath = String(dir || '').replace(/^\/+|\/+$/g, '').replace(/\.\./g, '').replace(/[^\w./-]/g, '');
  const cloudPath = ['contentMedia', subPath, finalName].filter(Boolean).join('/');
  const mime = contentTypeOf(originalName, String(contentType || '').split(';')[0].trim());

  const env = resolveEnvId();
  const apiKey = process.env.CLOUDBASE_API_KEY;

  let fileID;
  if (apiKey) {
    fileID = await uploadViaHttp(apiKey, env, cloudPath, buffer, mime);
  } else {
    const app = initCloudBase(env);
    const res = await app.uploadFile({ cloudPath, fileContent: buffer });
    fileID = res.fileID || '';
  }

  if (!fileID) throw new Error('上传成功但未返回文件 ID');

  // mediaUrl 存相对 contentMedia/ 的路径，后端 getContentMediaUrl 会自动补全前缀。
  const mediaUrl = cloudPath.replace(/^contentMedia\//, '');
  return { fileID, mediaUrl, cloudPath, contentType: mime, filename: finalName, size: buffer.length };
}

module.exports = { uploadContentMedia, resolveEnvId };
