const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const loadLocalEnv = () => {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
};

const resolvePrivateKeyPath = (privateKeyPath) => {
  if (!privateKeyPath) return '';
  return path.isAbsolute(privateKeyPath) ? privateKeyPath : path.resolve(__dirname, privateKeyPath);
};

const wrapPemBody = (body) => body.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim();

const normalizePrivateKey = (value) => {
  const privateKey = String(value || '').trim();
  if (!privateKey) return '';

  const normalized = privateKey.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  const pemMatch = normalized.match(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----([\s\S]*?)-----END (?:RSA )?PRIVATE KEY-----/,
  );
  if (pemMatch) {
    const beginLabel = normalized.includes('-----BEGIN RSA PRIVATE KEY-----') ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
    return `-----BEGIN ${beginLabel}-----\n${wrapPemBody(pemMatch[1])}\n-----END ${beginLabel}-----\n`;
  }

  try {
    const decoded = Buffer.from(privateKey, 'base64').toString('utf8').trim();
    if (decoded && decoded !== privateKey && decoded.includes('PRIVATE KEY')) {
      return normalizePrivateKey(decoded);
    }
  } catch (err) {
    // Ignore invalid base64 and let crypto report the final key parsing error.
  }

  return normalized;
};

const readPrivateKey = () => {
  const privateKeyPath = resolvePrivateKeyPath(process.env.WECHAT_PAY_PRIVATE_KEY_PATH || '');
  if (privateKeyPath) {
    return normalizePrivateKey(fs.readFileSync(privateKeyPath, 'utf8'));
  }
  return normalizePrivateKey(process.env.WECHAT_PAY_PRIVATE_KEY || process.env.WECHAT_PAY_PRIVATE_KEY_BASE64 || '');
};

loadLocalEnv();

const wxPayConfig = {
  appId: process.env.WECHAT_APP_ID || process.env.WX_APPID || '',
  appSecret: process.env.WECHAT_APP_SECRET || process.env.WX_APP_SECRET || '',
  mchId: process.env.WECHAT_PAY_MCH_ID || '',
  serialNo: process.env.WECHAT_PAY_SERIAL_NO || '',
  privateKeyPath: resolvePrivateKeyPath(process.env.WECHAT_PAY_PRIVATE_KEY_PATH || ''),
  privateKey: readPrivateKey(),
  apiV3Key: process.env.WECHAT_PAY_API_V3_KEY || '',
  notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || '',
  mockWhenUnconfigured: process.env.WECHAT_PAY_MOCK !== 'false',
  localTestAmount: Number(process.env.WECHAT_PAY_LOCAL_TEST_AMOUNT_FEN || 1),
};

const isLocalRuntime = () => !process.env.MYSQL_ADDRESS;

const isWxPayConfigured = () =>
  !!(wxPayConfig.appId && wxPayConfig.mchId && wxPayConfig.serialNo && wxPayConfig.privateKey && wxPayConfig.notifyUrl);

const getPayAmount = (amount) => {
  if (isLocalRuntime()) {
    return wxPayConfig.localTestAmount;
  }
  return Number(amount);
};

const randomString = (length = 32) => crypto.randomBytes(length).toString('hex').slice(0, length);

const rsaSign = (message) =>
  crypto.createSign('RSA-SHA256').update(message).end().sign(wxPayConfig.privateKey, 'base64');

if (wxPayConfig.privateKey) {
  try {
    crypto.createPrivateKey(wxPayConfig.privateKey);
  } catch (err) {
    console.error('微信支付商户私钥格式错误，请检查 WECHAT_PAY_PRIVATE_KEY 或 WECHAT_PAY_PRIVATE_KEY_PATH:', err.message);
  }
}

const requestWechatPay = (method, requestPath, body) => {
  const bodyText = body ? JSON.stringify(body) : '';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomString();
  const message = `${method}\n${requestPath}\n${timestamp}\n${nonceStr}\n${bodyText}\n`;
  const signature = rsaSign(message);
  const authorization =
    `WECHATPAY2-SHA256-RSA2048 mchid="${wxPayConfig.mchId}",nonce_str="${nonceStr}",` +
    `signature="${signature}",timestamp="${timestamp}",serial_no="${wxPayConfig.serialNo}"`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.mch.weixin.qq.com',
        path: requestPath,
        method,
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'User-Agent': 'user-management-wxpay/1.0',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(json.message || json.code || `微信支付请求失败：${res.statusCode}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyText);
    req.end();
  });
};

const buildPaymentParams = (prepayId) => {
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomString();
  const packageValue = `prepay_id=${prepayId}`;
  const signMessage = `${wxPayConfig.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
  return {
    timeStamp,
    nonceStr,
    package: packageValue,
    signType: 'RSA',
    paySign: rsaSign(signMessage),
  };
};

const createWechatPrepay = async ({ orderNo, openid, amount, description }) => {
  const payAmount = getPayAmount(amount);
  const prepay = await requestWechatPay('POST', '/v3/pay/transactions/jsapi', {
    appid: wxPayConfig.appId,
    mchid: wxPayConfig.mchId,
    description: String(description || '商品订单').slice(0, 127),
    out_trade_no: orderNo,
    notify_url: wxPayConfig.notifyUrl,
    amount: {
      total: payAmount,
      currency: 'CNY',
    },
    payer: { openid },
  });

  return {
    payAmount,
    prepayId: prepay.prepay_id,
    payInfo: buildPaymentParams(prepay.prepay_id),
  };
};

const getOpenidByCode = (code) => {
  if (!code || !wxPayConfig.appId || !wxPayConfig.appSecret) {
    return Promise.resolve('');
  }
  const urlPath = `/sns/jscode2session?appid=${wxPayConfig.appId}&secret=${wxPayConfig.appSecret}&js_code=${code}&grant_type=authorization_code`;
  return new Promise((resolve) => {
    https
      .get({ hostname: 'api.weixin.qq.com', path: urlPath }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.openid || '');
          } catch (err) {
            resolve('');
          }
        });
      })
      .on('error', () => resolve(''));
  });
};

const decryptNotifyResource = (resource) => {
  const ciphertext = Buffer.from(resource.ciphertext, 'base64');
  const authTag = ciphertext.slice(ciphertext.length - 16);
  const data = ciphertext.slice(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', wxPayConfig.apiV3Key, resource.nonce);
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(resource.associated_data || ''));
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
};

module.exports = {
  wxPayConfig,
  isLocalRuntime,
  isWxPayConfigured,
  getPayAmount,
  createWechatPrepay,
  getOpenidByCode,
  decryptNotifyResource,
};
