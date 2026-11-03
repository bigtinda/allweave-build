# Allweave & Build — High-Fidelity SVG Pack

本包依据用户提供的《Allweave 与 Build 品牌系统展板》进行高保真矢量重建。目标是保留海报中的原始视觉细节，而不是重新概括或简化图形。

## 核心文件

### Allweave（母品牌）
- `Allweave_Horizontal_Blue.svg` — 蓝色横向组合标志
- `Allweave_Mark_Blue.svg` — 点阵无穷符号
- `Allweave_Wordmark_Blue.svg` — 斜体衬线字标

### Build（Coding Agent 子品牌）
- `Build_Horizontal_Primary.svg` — 蓝色图形 + 深色字标的主版本
- `Build_Horizontal_Blue.svg` — 全蓝版本
- `Build_Mark_Blue.svg` — 双层斜切图形与点阵
- `Build_Wordmark_Blue.svg` — Build + BY ALLWEAVE 字标

## 文件内容
- Allweave：独立图形、独立字标、横向组合；蓝色、黑色、白色版本。
- Build：独立图形、独立字标、横向组合；蓝色、黑色、白色版本，以及主品牌配色版本。
- App Icons：Allweave 蓝底/浅底/深底版本；Build 蓝底/浅底/深底/描边版本。
- 所有字形均转为 SVG 路径，不依赖用户设备安装字体。

## 矢量重建说明
- Allweave 点阵符号：按海报点位逐个重建为独立圆形矢量元素，保留点阵轨迹和尺寸变化。
- Allweave 字标：根据海报原图轮廓描摹为可编辑矢量路径。
- Build 图形：保留上下两块斜切几何板及右侧点阵排列。
- Build 字标：使用海报所示的 Inter 字体体系重建，并将 Inter Display Bold / Inter Medium 字形转换为路径。

## 品牌颜色
- Klein Blue：`#002FA7`
- Text：`#0B1020`
- Canvas：`#F8FAFC`
- Border：`#E2E8F0`
- White：`#FFFFFF`

## 重要说明
原始输入是一张 PNG 品牌展板，而不是设计师提供的 AI / SVG 母版。因此本包属于基于海报可见像素的高保真矢量重建，不应被描述为原始源文件的直接导出。Allweave 字标的细节来自原图轮廓描摹；Build 字标依据海报中的字体系统转为路径。正式商标提交或大幅印刷前，建议再与品牌设计源文件核对一次。

## 文件格式
SVG 1.1，透明背景（App Icon 除外）。可在 Figma、Illustrator、Inkscape 中继续编辑。
