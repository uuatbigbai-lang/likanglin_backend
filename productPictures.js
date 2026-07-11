/**
 * Product picture helpers.
 * 每个 SPU 的 banners/details/sku 图片统一存储在云托管文件目录，BFF 负责拼装小程序固定读取的字段。
 */
const CLOUD_STORAGE_BASE = process.env.CLOUD_STORAGE_BASE;
if(!CLOUD_STORAGE_BASE) {
  throw new Error('CLOUD_STORAGE_BASE is not defined in environment variables.');
}
const GOODS_PICTURE_CLOUD_BASE = `${CLOUD_STORAGE_BASE}/goodsPicture`;
const HOME_BANNER_CLOUD_BASE = `${CLOUD_STORAGE_BASE}/homeBanner`;
const HOME_ASSET_CLOUD_BASE = `${CLOUD_STORAGE_BASE}/homeAsset`;
const DEFAULT_DETAIL_BANNER_HEIGHT = 750;
const PRODUCT_DISPLAY_CONFIG = {
  // 这款商品的 banner 原图偏高，提升详情页轮播高度以减少左右留白。
  spu_probiotic_02: {
    detailBannerHeight: 565,
  },
};

const isAbsolutePicture = (value = '') => /^https?:\/\//.test(value) || String(value).startsWith('cloud://');
const trimLeadingSlash = (value = '') => String(value).replace(/^\/+/, '');

const getProductPicture = (spuId, fileName) => `${GOODS_PICTURE_CLOUD_BASE}/${spuId}/${fileName}`;
const getHomeAssetPicture = (fileName) => {
  if (!fileName) return '';
  if (isAbsolutePicture(fileName)) return fileName;
  return `${HOME_ASSET_CLOUD_BASE}/${trimLeadingSlash(fileName)}`;
};

const getHomeBannerPicture = (fileName) => {
  if (!fileName) return '';
  if (isAbsolutePicture(fileName)) return fileName;
  return `${HOME_BANNER_CLOUD_BASE}/${trimLeadingSlash(fileName)}`;
};

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
  const pictureSpuId = data.pictureSpuId || data.spuId;
  const banners = getProductBanners(pictureSpuId, bannerCount);
  const useThumb = data.useThumb === true || data.useThumb === 1;
  const usePicture = data.usePicture === true || data.usePicture === 1;
  const thumb = useThumb ? getThumbPicture(pictureSpuId) : banners[0] || '';
  const primaryImage = banners[0] || thumb;
  const displayConfig = PRODUCT_DISPLAY_CONFIG[data.spuId] || {};
  const showPriceFrom = Array.isArray(data.skuList) ? data.skuList.length > 1 : false;

  return {
    ...data,
    detailBannerHeight: Number(displayConfig.detailBannerHeight) || DEFAULT_DETAIL_BANNER_HEIGHT,
    showPriceFrom,
    thumb,
    primaryImage,
    images: banners,
    skuList: Array.isArray(data.skuList)
      ? data.skuList.map((sku) => ({
          ...sku,
          skuImage: usePicture || sku.usePicture ? getSkuPicture(pictureSpuId, sku.skuId) : primaryImage,
        }))
      : data.skuList,
    desc: getProductDetails(pictureSpuId, detailCount),
  };
};

const withCloudHomeAssetPicture = (asset) => {
  const data = asset && typeof asset.toJSON === 'function' ? asset.toJSON() : { ...asset };
  return {
    ...data,
    url: getHomeAssetPicture(data.url),
  };
};

const withCloudHomeBannerPicture = (banner) => {
  const data = banner && typeof banner.toJSON === 'function' ? banner.toJSON() : { ...banner };
  return {
    ...data,
    imageUrl: getHomeBannerPicture(data.imageUrl),
  };
};

module.exports = {
  withCloudProductPictures,
  withCloudHomeAssetPicture,
  withCloudHomeBannerPicture,
};
