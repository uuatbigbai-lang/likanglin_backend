const crypto = require('crypto');

const ADMIN_SESSION_TTL_MS = 1 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_TOKEN || 'admin-session-secret';

const sha256Hex = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const randomHex = (size = 16) => crypto.randomBytes(size).toString('hex');
const hashAdminPassword = (password, salt) => sha256Hex(`${salt}:${password}`);

const buildAdminSessionToken = (account) => {
  const payload = {
    id: String(account.id),
    username: String(account.username || ''),
    roleType: String(account.roleType || 'sales'),
    exp: Date.now() + ADMIN_SESSION_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
};

const parseAdminSessionToken = (token) => {
  const raw = String(token || '').trim();
  if (!raw || !raw.includes('.')) return null;
  const [encodedPayload, signature] = raw.split('.');
  if (!encodedPayload || !signature) return null;
  const expectedSignature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(encodedPayload).digest('base64url');
  if (signature !== expectedSignature) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!payload?.id || !payload?.exp || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch (err) {
    return null;
  }
};

const formatAdminAccount = (account) => {
  if (!account) return null;
  const data = typeof account.toJSON === 'function' ? account.toJSON() : account;
  return {
    id: data.id,
    username: data.username,
    roleType: data.roleType || 'sales',
    displayName: data.displayName || data.username,
    status: Number(data.status ?? 1),
    updatedAt: data.updatedAt,
  };
};

const createAdminAuth = ({ AdminAccount }) => async (req, res, next) => {
  const fallbackToken = process.env.ADMIN_TOKEN || '';
  const requestToken = String(req.headers['x-admin-token'] || req.query.token || (req.body && req.body.token) || '').trim();

  if (fallbackToken && requestToken === fallbackToken) {
    req.adminAccount = { username: 'env-admin-token', roleType: 'admin', displayName: '环境变量管理员' };
    return next();
  }

  const payload = parseAdminSessionToken(requestToken);
  if (!payload) {
    return res.status(401).send({ code: -1, message: '未授权，请先登录后台账号' });
  }

  try {
    const account = await AdminAccount.findByPk(payload.id);
    if (!account || Number(account.status) !== 1) {
      return res.status(401).send({ code: -1, message: '账号不可用，请联系管理员' });
    }
    req.adminAccount = formatAdminAccount(account);
    return next();
  } catch (err) {
    return res.status(401).send({ code: -1, message: '登录状态校验失败' });
  }
};

const registerAdminAuthRoutes = ({ app, AdminAccount, adminAuth }) => {
  app.post('/api/admin/login', async (req, res) => {
    try {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      if (!username || !password) {
        return res.send({ code: -1, message: '请输入账号和密码' });
      }

      const account = await AdminAccount.findOne({ where: { username } });
      if (!account || Number(account.status) !== 1) {
        return res.send({ code: -1, message: '账号或密码错误' });
      }

      const passwordHash = hashAdminPassword(password, account.passwordSalt);
      if (passwordHash !== account.passwordHash) {
        return res.send({ code: -1, message: '账号或密码错误' });
      }

      return res.send({
        code: 0,
        data: {
          token: buildAdminSessionToken(account),
          account: formatAdminAccount(account),
        },
      });
    } catch (err) {
      return res.send({ code: -1, message: err.message });
    }
  });

  app.get('/api/admin/me', adminAuth, async (req, res) => {
    res.send({ code: 0, data: req.adminAccount || null });
  });
};

const buildSeedAdminAccounts = () => (
  [
    {
      username: 'admin',
      password: 'admin123456',
      roleType: 'admin',
      displayName: '系统管理员',
    },
    {
      username: 'sales',
      password: 'sales123456',
      roleType: 'sales',
      displayName: '销售顾问',
    },
  ].map((item) => {
    const passwordSalt = randomHex(8);
    return {
      username: item.username,
      passwordSalt,
      passwordHash: hashAdminPassword(item.password, passwordSalt),
      roleType: item.roleType,
      displayName: item.displayName,
      status: 1,
    };
  })
);

module.exports = {
  createAdminAuth,
  registerAdminAuthRoutes,
  buildSeedAdminAccounts,
};
