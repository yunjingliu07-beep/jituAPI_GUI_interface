// size is a pixel string on the API; the longest edge follows the selected clarity.
export function requestedSize(settings) {
  const [w,h]=settings.ratio==='custom'?[Number(settings.customRatioWidth),Number(settings.customRatioHeight)]:String(settings.ratio).split(':').map(Number);
  const base=Number(settings.resolution);
  if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0||w>10000||h>10000)throw new Error('请填写大于 0、不超过 10000 的宽高比例。');
  if(!Number.isInteger(base)||base<64||base>8192)throw new Error('请选择有效的图片清晰度。');
  const width=w>=h?base:Math.round(base*w/h/8)*8;
  const height=w>=h?Math.round(base*h/w/8)*8:base;
  if(width<64||height<64||width>8192||height>8192)throw new Error('这个比例在当前清晰度下过于极端。请调整比例，使宽高均在 64 至 8192 像素之间。');
  return {size:`${width}x${height}`,width,height,ratioLabel:`${w}:${h}`};
}
