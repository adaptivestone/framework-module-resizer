// Legacy public subpath. Keep runtime helpers outside src/config so framework-loaded
// configuration files remain declarative.
export { default } from './config/resize.ts';
export { getResizeConfig, requiredFormats } from './resizeConfig.ts';
