/**
 * Product picture helpers.
 * 每个 SPU 的 banners/details/sku 图片统一存储在云托管文件目录，BFF 负责拼装小程序固定读取的字段。
 */
const GOODS_PICTURE_CLOUD_BASE =
  'cloud://cloud1-d8gcvzv3307e57219.636c-cloud1-d8gcvzv3307e57219-1425492866/goodsPicture';

const getProductPicture = (spuId, fileName) => `${GOODS_PICTURE_CLOUD_BASE}/${spuId}/${fileName}`;

const getProductBanners = (spuId, count) =>
  Array.from({ length: count }, (_, index) => getProductPicture(spuId, `banner${index + 1}.png`));

const getProductDetails = (spuId, count) =>
  Array.from({ length: count }, (_, index) => getProductPicture(spuId, `detail${index + 1}.png`));

const getSkuPicture = (spuId, skuId) => {
  const fileName = `${String(skuId).replace(/[^a-zA-Z0-9]/g, '')}.png`;
  return getProductPicture(spuId, fileName);
};

const getThumbPicture = (spuId) => getProductPicture(spuId, 'thumb.png');

const withCloudProductPictures = (product) => {
  const data = product && typeof product.toJSON === 'function' ? product.toJSON() : { ...product };
  if (!data.spuId) return data;

  const bannerCount = Number(data.bannerLength) || 0;
  const detailCount = Number(data.detailPicLength) || 0;
  const banners = getProductBanners(data.spuId, bannerCount);
  const useThumb = data.useThumb === true || data.useThumb === 1;
  const usePicture = data.usePicture === true || data.usePicture === 1;
  const thumb = useThumb ? getThumbPicture(data.spuId) : banners[0] || '';
  const primaryImage = banners[0] || thumb;

  return {
    ...data,
    thumb,
    primaryImage,
    images: banners,
    skuList: Array.isArray(data.skuList)
      ? data.skuList.map((sku) => ({
          ...sku,
          skuImage: usePicture || sku.usePicture ? getSkuPicture(data.spuId, sku.skuId) : primaryImage,
        }))
      : data.skuList,
    desc: getProductDetails(data.spuId, detailCount),
  };
};

module.exports = {
  withCloudProductPictures,
};
