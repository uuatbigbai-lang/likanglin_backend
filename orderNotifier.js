const https = require('https');

// 可通过云托管环境变量覆盖；留空可完全关闭订单群通知。
const DEFAULT_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a36ef8bf-83a7-4425-a27c-f6d8c84c6635';
const WEBHOOK_URL = Object.prototype.hasOwnProperty.call(process.env, 'WECOM_ORDER_WEBHOOK_URL')
  ? process.env.WECOM_ORDER_WEBHOOK_URL
  : DEFAULT_WEBHOOK_URL;

const ORDER_STATUS_FIELDS = new Set(['orderStatus', 'orderStatusName']);

const escapeMarkdown = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const formatMoney = (value) => {
  const amount = Number(value || 0);
  return `¥${((Number.isFinite(amount) ? amount : 0) / 100).toFixed(2)}`;
};
const formatTime = (value) => {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};
const getOrderData = (order) => (typeof order?.toJSON === 'function' ? order.toJSON() : (order || {}));
const getCustomer = (order) => {
  const address = order.userAddress || {};
  return order.userName || address.name || address.userName || '未填写';
};
const getGoodsSummary = (goodsList) => {
  if (!Array.isArray(goodsList) || !goodsList.length) return '未填写';
  const summary = goodsList.map((goods) => `${goods.goodsName || goods.name || goods.spuName || '未命名商品'} ×${Number(goods.quantity || goods.buyQuantity || 1)}`).join('、');
  return summary.length > 140 ? `${summary.slice(0, 137)}...` : summary;
};
const getChangedFields = (order) => (
  typeof order.changed !== 'function' ? [] : (order.changed() || [])
);
const hasOrderStatusChanged = (order) => getChangedFields(order).some((field) => ORDER_STATUS_FIELDS.has(field));
const getStatusChangeText = (order) => {
  const current = order.orderStatusName || order.orderStatus || '-';
  if (typeof order.previous !== 'function') return String(current);
  const previous = order.previous('orderStatusName') || order.previous('orderStatus');
  return previous && String(previous) !== String(current) ? `${previous} → ${current}` : String(current);
};

const buildOrderMarkdown = (event, rawOrder) => {
  const order = getOrderData(rawOrder);
  const eventMeta = { created: { icon: '🆕', title: '订单新增' }, updated: { icon: '🔄', title: '订单状态变更' }, deleted: { icon: '🗑️', title: '订单删除' } }[event] || { icon: '🔔', title: '订单变更' };
  const lines = [
    `## ${eventMeta.icon} ${eventMeta.title}`,
    `> 订单号：<font color="comment">${escapeMarkdown(order.orderNo || '-')}</font>`,
    `> 客户：<font color="info">${escapeMarkdown(getCustomer(order))}</font>`,
    `> 商品：${escapeMarkdown(getGoodsSummary(order.goodsList))}`,
    `> ${event === 'deleted' ? '订单金额' : '实付金额'}：<font color="warning">${formatMoney(order.paymentAmount || order.totalAmount)}</font>`,
    `> ${event === 'updated' ? '状态变更' : '当前状态'}：${escapeMarkdown(event === 'updated' ? getStatusChangeText(rawOrder) : (order.orderStatusName || '-'))}`,
    `> ${event === 'created' ? '创建时间' : event === 'deleted' ? '删除时间' : '变更时间'}：${formatTime(event === 'created' ? order.createdAt : Date.now())}`,
  ];
  if (order.remark) lines.push(`> 备注：${escapeMarkdown(order.remark)}`);
  return lines.join('\n');
};

const postWebhook = (payload) => new Promise((resolve, reject) => {
  const url = new URL(WEBHOOK_URL);
  const body = JSON.stringify(payload);
  const request = https.request({ protocol: url.protocol, hostname: url.hostname, port: url.port || 443, path: `${url.pathname}${url.search}`, method: 'POST', timeout: 5000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (response) => {
    let responseBody = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { responseBody += chunk; });
    response.on('end', () => {
      if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode}: ${responseBody}`));
      try {
        const result = JSON.parse(responseBody || '{}');
        if (result.errcode && result.errcode !== 0) return reject(new Error(result.errmsg || `errcode ${result.errcode}`));
      } catch (err) { return reject(new Error(`响应格式异常: ${err.message}`)); }
      resolve();
    });
  });
  request.on('timeout', () => request.destroy(new Error('请求超时')));
  request.on('error', reject);
  request.write(body);
  request.end();
});

const notifyOrderChange = (event, order) => {
  if (!WEBHOOK_URL) return;
  if (event === 'updated' && !hasOrderStatusChanged(order)) return;
  const orderNo = getOrderData(order).orderNo || 'unknown';
  postWebhook({ msgtype: 'markdown', markdown: { content: buildOrderMarkdown(event, order) } })
    .then(() => console.log(`📣 企业微信订单${event}通知已发送: ${orderNo}`))
    .catch((err) => console.error(`企业微信订单${event}通知失败 (${orderNo}):`, err.message));
};
const registerOrderNotificationHooks = (Order) => {
  Order.afterCreate((order) => notifyOrderChange('created', order));
  Order.afterUpdate((order) => {
    if (hasOrderStatusChanged(order)) notifyOrderChange('updated', order);
  });
  Order.afterDestroy((order) => notifyOrderChange('deleted', order));
};

module.exports = { buildOrderMarkdown, hasOrderStatusChanged, notifyOrderChange, registerOrderNotificationHooks };
