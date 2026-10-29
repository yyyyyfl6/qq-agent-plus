# 液态玻璃壁纸的来源

`liquid-wallpaper.png` 取自 [Kyant0/AndroidLiquidGlass](https://github.com/Kyant0/AndroidLiquidGlass)
的演示应用（`app/src/commonMain/composeResources/drawable/wallpaper_light.webp`），
该仓库以 Apache License 2.0 发布。

用途：液态玻璃材质需要一个「有内容可透」的衬底 —— 参考实现的玻璃就是浮在这张壁纸上。
本仓库只在「材质 = 液态玻璃」且「背景 = 无」时把它铺在 `html` 上，并在 `body` 上压一层
半透明暗角/白纱保证控制台文字的可读性；用户显式选择纯色/渐变背景时不会启用它。

改动说明：原图（1179×2556）等比缩到宽 1000px 并转成 PNG，以匹配本仓库静态服务的
`Content-Type` 表（只列了 png/svg/css/js/html，png 同时会走内容哈希长缓存）。
