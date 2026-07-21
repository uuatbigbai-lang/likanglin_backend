(function initAdminOrderExport(global) {
  function formatExcelDate(value) {
    if (!value && value !== 0) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function buildOrderExportRows(orders, helpers) {
    const { money } = helpers;
    return orders.map((order) => {
      const logistics = order.logisticsVO || {};
      const payment = order.paymentVO || {};
      const couponSnapshot = order.couponSnapshot || {};
      const items = Array.isArray(order.orderItemVOs) ? order.orderItemVOs : [];
      const goodsText = items.length
        ? items.map((item) => [
            item.goodsName || '商品',
            `SKU：${item.skuId || '-'}`,
            `数量：${item.buyQuantity || 1}`,
          ].join(' / ')).join('\n')
        : '无商品信息';
      const receiver = [logistics.receiverName, logistics.receiverPhone].filter(Boolean).join(' ');
      const receiverAddress = [
        logistics.receiverProvince,
        logistics.receiverCity,
        logistics.receiverCountry,
        logistics.receiverArea,
        logistics.receiverAddress,
      ].filter(Boolean).join('');
      const logisticsText = [
        logistics.logisticsCompanyName || '-',
        logistics.logisticsNo || '',
      ].filter((value, index) => index === 0 || value).join('\n');
      const statusText = order.rightsNo
        ? `${order.orderStatusName || '-'}\n售后：${order.rightsNo}`
        : (order.orderStatusName || '-');
      const couponRemarkParts = [];
      if (order.couponNo || couponSnapshot.couponNo) {
        couponRemarkParts.push(`优惠券名称：${couponSnapshot.title || '-'}`);
        couponRemarkParts.push(`优惠券类型ID：${couponSnapshot.templateType || '-'}`);
        couponRemarkParts.push(`优惠券券号：${order.couponNo || couponSnapshot.couponNo || '-'}`);
        couponRemarkParts.push(`优惠券规则：${couponSnapshot.ruleType || '-'}`);
        couponRemarkParts.push(`优惠抵扣：${money(order.couponAmount || couponSnapshot.discountAmount || 0)}`);
        if (couponSnapshot.ruleType === 'discount') {
          couponRemarkParts.push(`折扣券说明：本单使用折扣券，类型ID为 ${couponSnapshot.templateType || '-'}`);
        }
      }
      if (order.remark) {
        couponRemarkParts.unshift(`订单备注：${order.remark}`);
      }
      const exportRemark = couponRemarkParts.join('\n') || '-';

      return {
        订单号: order.orderNo || '',
        订单ID: order.orderId || '',
        微信交易单号: payment.transactionId || payment.channelTrxNo || payment.traceNo || '',
        商品: goodsText,
        金额: `${money(order.paymentAmount || order.totalAmount)}\n商品：${money(order.goodsAmount || order.totalAmount)}`,
        状态: statusText,
        收件信息: `${receiver || '-'}\n${receiverAddress || '-'}`,
        物流: logisticsText,
        备注: exportRemark,
        商品明细JSON: JSON.stringify(items),
        支付信息JSON: JSON.stringify(payment),
        收货信息JSON: JSON.stringify(logistics),
        物流轨迹JSON: JSON.stringify(order.trajectoryVos || []),
        优惠券快照JSON: JSON.stringify(order.couponSnapshot || null),
        订单原始JSON: JSON.stringify(order),
      };
    });
  }

  function exportOrdersToExcel(orders, helpers) {
    const { escapeHtml, showNotice, updateExportButtonState, getStatusText } = helpers;
    if (!orders.length) {
      showNotice('当前没有可导出的订单', true);
      updateExportButtonState();
      return;
    }

    const rows = buildOrderExportRows(orders, helpers);
    const headers = Object.keys(rows[0] || {});
    const headerHtml = headers.map((title) => `<th>${escapeHtml(title)}</th>`).join('');
    const bodyHtml = rows.map((row) => (
      `<tr>${headers.map((key) => `<td style="mso-number-format:'\\@';">${escapeHtml(row[key])}</td>`).join('')}</tr>`
    )).join('');
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body>
  <table border="1">
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>
</body>
</html>`;
    const blob = new Blob(['\ufeff', html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const link = document.createElement('a');
    const fileName = `订单导出_${getStatusText()}_${formatExcelDate(new Date()).replace(/[: ]/g, '-')}.xls`;
    const href = URL.createObjectURL(blob);
    link.href = href;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(href);
    showNotice(`已导出 ${orders.length} 条订单到 Excel`);
    updateExportButtonState();
  }

  global.createAdminOrderExport = function createAdminOrderExport(helpers) {
    return {
      exportOrders(orders) {
        exportOrdersToExcel(orders, helpers);
      },
    };
  };
}(window));
