# 文明与地图

在浏览器里生成一颗会自己"长"出来的星球:从板块漂移、流水侵蚀、气候算起,再推演三千年的民族、国家与历史 ——
给写原创世界观的作者当设定底稿,生成之后还能接着改名、改地形、改写历史。

## 能做什么

- **一颗完整的星球**:板块碰撞出山脉,河流切出河谷、流进大海,风和水汽决定哪里是雨林、哪里是荒漠;约 1 秒生成
- **地图是一整个球面**:东西相连、有南北极,可以左右无限拖动;也能切成 3D 地球仪,或罗宾森、摩尔威德、墨卡托等投影
- **多种图层**:政区、民族、地形是奇幻手绘风,实景是写实地貌;另有生态、高程、板块、气温、降水等数据图层;还能回放世界形成的过程
- **三千年历史推演**:民族扩散、建城立国、战争与议和、分裂与合并、改朝换代、同化与迁徙、城市兴衰;播放或拖动底部的时间轴,看任意一年的政区
- **中文地名**:山、河、湖、海、国、城自动起名(多种西幻音译与东方意象的语感),按中文地图的字列排版标注
- **世界概览**:点左上角的世界名,看历代国家的列表、编年史(推演里的大事写成中文纪事,点一条就跳到那一年、那个地方)和自己下过的干预
- **新建世界**:先定下星球的样子 —— 种子、陆地比例、板块数量、气温降水等参数,还能放火山、拉山脉、挖湖、抬起陆地、沉成海;
  点"创建世界"后推演三千年历史,种子、参数和地形就此定下(改一处地形,整段历史都会跟着变)
- **动手改**:单击任何地方看详情、改名;在国家面板下命令(保护、禁止分裂、禁止扩张、结盟、宣战、迁都),
  或在某一州立国、把它划给别国,从那一年起重推历史;想换地形就"以它为底稿新建",原来的世界不动
- **存档与分享**:同一个种子 + 参数永远是同一个世界;建好的世界自动存在浏览器里(「我的世界」),也能存成几 KB 的存档文件,
  或复制一条带着全部修改的分享链接
- **导出**:地图图片(PNG / JPEG,按当前投影)、图例、高度图(16 位 / 8 位)、编年史(Markdown / 纯文本)、地球仪当前这一面
- **AI 叙事与改写(可选)**:填上自己的 DeepSeek 或阿里云百炼密钥,把推演出的历史写成史书,给国名、地名、族名讲由来、起新名;
  或者用一句话说想怎么改("让某国多撑三百年""在北边的海里放一座火山岛"),AI 把它翻成上面这些命令、改名、改地形(改地形只在新建时),勾选确认后才执行
- **键盘快捷键**(电脑上):空格播放 / 暂停历史,← → 前后 10 年,1–4 换图层,/ 搜索,⌘Z 撤销最近一次修改……按 ? 看全部

## 在线使用

<!-- 网址待定 -->

打开网页就能用,不用安装、不用注册。

## 本地运行

需要 Node 22 以上和 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm dev        # 打开 http://localhost:5188
```

网址参数可以直接指定世界和画面,比如 `?seed=7&layer=cultures`(种子 7、民族图层)、`?seed=2024&layer=realistic&proj=robinson`(实景、罗宾森投影);
图层名见 `src/ui/mapLayers.ts`。

## 开发命令

```bash
pnpm typecheck             # 类型检查
pnpm test                  # 单元测试
pnpm stress                # 极端参数压力测试:出现 NaN 就失败,顺带打印各步耗时
pnpm smoke                 # 冒烟测试:无头浏览器里加载、回放、悬停、各界面流程
pnpm test:visual           # 画面回归:固定种子渲染缩略图,和 tests/visual/baseline/ 里的基准图逐像素比
pnpm test:visual --update  # 画面是有意改的:用当前画面更新基准图,和代码一起提交
pnpm build                 # 生产构建(输出到 dist/)
```

冒烟测试、画面回归和截图脚本要用无头浏览器,第一次先装:`pnpm exec playwright install chromium`。

截图和调试脚本(都会自己起一个临时服务,不用先 `pnpm dev`;截图默认写到 `snaps/`,这个目录不进仓库):

```bash
npx tsx scripts/snap.ts "seed=7&style=fantasy" snaps/x.png canvas              # 整张地图原图
npx tsx scripts/snap.ts "seed=7&style=fantasy" snaps/z.png zoom=4,0.7,0.3      # 滚轮放大 4 倍再截,看文字清不清楚
npx tsx scripts/snap.ts "seed=7&style=fantasy" snaps/c.png crop=800,300,300,200,3  # 局部放大
npx tsx scripts/globe-snap.ts "seed=7&civ=polities" snaps/g.png 30,20,1 0,90,1  # 地球仪(经度,纬度,缩放)
npx tsx scripts/gen-stats.ts 7             # 打印一个世界的统计数字(地形、国家、战争、王朝……)
npx tsx scripts/names-demo.ts              # 各种语感的地名样品
npx tsx scripts/subset-fonts.ts            # 重新裁剪地图字体(地名生成器加了新字、单测报"缺字"时)
```

## 代码结构

```
src/
├── gen/            世界生成:纯计算,不碰界面,在后台线程(也能在 Node)里跑
│   ├── geometry.ts     几何层:球面上的距离、噪声、纬度、最近的地块;生成和文明都通过它算,不直接拿 x、y 算
│   ├── mesh.ts         网格:几万个不规则地块
│   ├── tectonics.ts    板块、大陆轮廓、抬升
│   ├── erosion.ts      流水侵蚀与排水
│   ├── climate.ts      温度、风带、水汽、降水
│   ├── biomes.ts       生物群落
│   ├── seaice.ts       海冰
│   ├── world.ts        总流程、湖泊、河道
│   ├── raster.ts       网格 → 等距圆柱主图的像素
│   ├── history.ts      形成过程的回放帧
│   ├── terrainEdits.ts 改地形(火山、山脉、湖、抬升 / 下沉)
│   ├── edits.ts        使用者的修改:稳定键、改名、干预、地形修改的格式;生成器版本
│   ├── savefile.ts     存档文件格式
│   ├── heightmap.ts    高度图编码
│   ├── names/          地名生成器
│   └── civ/            文明:宜居度、州、推演引擎、民族、城市与国家、战争、分合、王朝、同化迁徙、城市兴衰、
│                       干预、编年史、道路、地理名称
├── render/         画风:只读世界数据,切换画风不用重新生成
│   ├── realistic.ts / fantasy.ts / layers.ts   写实、手绘、数据图层
│   ├── projection.ts   各种地图投影
│   ├── globe*.ts       3D 地球仪(WebGL2,另有 CPU 退路)
│   ├── civ/            文明叠加层:国土、国界、道路、城镇符号、高亮
│   ├── labels/         地图文字:排版、避让、字体
│   └── export.ts       导出图片、图例
├── ai/             AI 接入:唯一入口 aiChat、各家服务商、设置与密钥、本地调用记录、提示词
├── ui/             界面(React)
├── worker.ts / exportWorker.ts / globeWorker.ts   后台线程
└── main.tsx
scripts/            冒烟测试、压力测试、画面回归、截图、统计、字体裁剪等脚本(lib/ 是它们共用的零件)
tests/              单元测试(vitest);visual/baseline/ 是画面回归的基准图
public/fonts/       地图文字用的字体子集和许可证
```

几条约定:

- **同一个种子必须生成同一个世界**:所有随机数都从 `subSeed(seed, '用途')` 取,不用 `Math.random`;
  同一版本下,不同电脑、浏览器生成的地形和历史逐位一致(有单测核对)
- 改了生成算法、同一个种子得到的世界变了,就把 `src/gen/edits.ts` 里的 `GENERATOR_VERSION` 加一(旧存档靠它提示"来自旧版本")
- 性能预算:默认 36k 地块,生成 + 铺像素不超过 2 秒

## 隐私

所有计算都在你的浏览器里完成,世界、存档和 AI 写的内容只存在本机。
使用 AI 功能时,你填的密钥只存在这个浏览器里,请求由网页直接发给你选的模型厂商,不经过我们的服务器。

## 参考与致谢

算法思路参考了这些公开资料(未复制代码):

- Braun & Willett (2013) — 流水功率侵蚀的隐式解法
- Barnes et al. (2014) — Priority-Flood 洼地填平
- Cordonnier et al. (2016) — 构造抬升 + 河流侵蚀生成大尺度地形
- Red Blob Games《mapgen4》、Martin O'Leary《Generating fantasy maps》、Azgaar Fantasy Map Generator

地图文字用的字体(按地名字表裁剪成子集,放在 `public/fonts/`,不依赖任何在线字体服务):

- **霞鹜文楷 GB**(LXGW WenKai GB,[lxgw/LxgwWenkaiGB](https://github.com/lxgw/LxgwWenkaiGB) v1.522)——手绘风。
  © LXGW,基于 Fontworks 的 Klee One;SIL Open Font License 1.1,许可证附加条款允许为网页裁剪 / 转换后沿用原名
- **思源宋体 Google 版**(Noto Serif SC,[google/fonts](https://github.com/google/fonts/tree/main/ofl/notoserifsc) 2.003)——写实风。
  © Adobe;SIL Open Font License 1.1

许可证全文和来源校验值见 `public/fonts/` 里的 `OFL-*.txt`、`SOURCES.txt`。

## 参与

欢迎提 issue 报告问题、提建议,详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

代码:[GNU AGPL-3.0](LICENSE)(仅第 3 版),© 2026 guaner-334。
可以自由使用、修改、再发布;**把改过的版本做成网站给别人用,也必须按同样的协议公开改过的完整源代码**。
应用里预留了一个官方 AI 服务的入口(尚未开放),它的服务器端是另一个独立程序,不包含在本仓库中。

第三方依赖各有许可(MIT / ISC / Unlicense);字体:SIL Open Font License 1.1(见上)。
