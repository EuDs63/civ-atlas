/**
 * 屏蔽表:不吉利的字、不雅字词、现实里太有名的地名 / 人名 / 品牌、宗教与神话里的名字、他人作品里的名字。
 * 生成器每出一个候选名都过一遍,命中就重抽。
 *
 * 为了源码里不出现明文的不雅词,不雅字、脏话、蔑称这几组是编码存的(UTF-8 的 base64,词之间用空格隔开),模块加载时解码。
 */

/** 解码编码存的一组字词 */
function decode(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

/** 任何名字里都不许出现的字 */
export const BLOCKED_CHARS = new Set([
  // 不吉利、贬义的字
  ...'死尸癌病疯丑臭滚杀毒灾丧殡葬坟墓棺',
  // 称谓(放进名字里读着不像名字)
  ...'妈爸娘爹',
  // 不雅字、骂人的字、贬称(编码存储)
  ...decode('5bGO5bC/57Kq5bGB5rer5aaT5ai85aW46LSx5amK5bGM6YC85pON6Im55Y216JuL6bih6bit5YK76KCi5aW06JmP6Juu5aS35oiO54uE6Zi06IKb' +
    '5Lmz6KO45bGE5ZCK'),
]);

/** 出现在名字任何位置都不行的组合 */
const BLOCKED_SUBSTR = [
  // 现实地名(做成子串屏蔽的只收两字以上、不会误伤的)
  '中国', '中华', '华夏', '上海', '北京', '南京', '东京', '天津', '重庆', '香港', '澳门', '台湾', '台北', '深圳', '珠海', '广州', '杭州',
  '苏州', '郑州', '兰州', '贵州', '武汉', '成都', '西安', '沈阳', '长春', '哈尔滨', '昆明', '南宁', '福州', '厦门', '合肥', '济南', '青岛',
  '大连', '拉萨', '银川', '西宁', '海口', '三亚', '宁波', '呼和浩特', '乌兰浩特', '锡林浩特', '二连浩特', '乌鲁木齐', '喀什', '阿克苏',
  '克拉玛依', '吐鲁番', '哈密', '新疆', '西藏', '宁夏', '青海', '内蒙', '云南', '四川', '湖南', '湖北', '河南', '河北', '山东', '山西',
  '广东', '广西', '江苏', '浙江', '安徽', '江西', '福建', '辽宁', '吉林', '黑龙江', '甘肃', '陕西', '海南', '日本', '韩国', '朝鲜', '美国',
  '英国', '法国', '德国', '俄国', '汉堡', '巴西', '古巴', '迪拜', '伊拉克', '卡塔尔', '索马里', '苏丹', '利比亚', '肯尼亚', '赞比亚',
  '贝宁', '加纳', '巴哈马', '波兰', '芬兰', '卢森堡', '苏格兰', '英格兰', '艾尔兰', '阿尔萨斯', '塞尔维亚', '罗马尼亚', '阿尔巴尼亚',
  '巴基斯坦', '哈萨克', '乌克兰', '罗马', '米兰', '巴黎', '伦敦', '柏林', '维也纳', '威尼斯', '莫斯科', '雅典', '开罗', '德里', '曼谷', '首尔',
  // 现实人名
  '希特勒', '列宁', '泽东', '拉登',
  // 现实里的政体、人群称呼
  '纳粹', '民国', '共和', '白人', '黑人',
  // 宗教与神话
  '伊斯兰', '穆斯林', '麦加', '阿门', '萨坦', '撒旦',
  // 品牌
  '特斯拉', '宝马', '奔驰', '丰田', '本田', '吉利', '华为', '小米', '京东', '淘宝', '百度', '腾讯', '阿里巴巴', '迪士尼', '耐克', '阿迪达斯',
  // 外来词(音译字碰巧拼出来的)
  '马达', '纳米', '沙拉', '拉丁', '卡通', '雷达', '布丁', '迪斯科', '托福', '克隆', '吉普', '坦克', '马拉松', '马赛克', '比萨', '巴士',
  '可乐', '沙龙', '摩托', '奥斯卡',
  // 谐音的脏话、网络脏话(编码存储)
  ...decode('5rKZ5q+UIOiQqOavlCDnhZ7nrJQg5YK75q+UIOWwvOeOmyDms6Xpqawg54m55LmIIOS7luWmiCDljafmp70g5be05ZiOIOWFq+WYjiDlkInlkIkg' +
    '5Z+65L2sIOiPiuiKsSDmi4nnqIA=').split(' '),
];

/** 整个名字等于它们时屏蔽(单独出现才别扭的) */
const BLOCKED_EXACT = new Set([
  // 现实地名(含古地名)
  '阿曼', '巴林', '马里', '马来', '智利', '秘鲁', '印度', '越南', '老挝', '缅甸', '蒙古', '伊朗', '约旦', '也门', '北韩', '南韩',
  '东海', '南海', '北海', '西海', '黄海', '渤海', '黑海', '白海', '红海', '死海', '里海', '长江', '黄河', '珠江', '淮河', '汉江', '湘江',
  '漓江', '海河', '辽河', '渭河', '汾河', '闽江', '赣江', '乌江', '怒江', '黄山', '泰山', '华山', '衡山', '恒山', '嵩山', '天山', '昆仑山',
  '长白山', '峨眉山', '武当山', '五台山', '九华山', '三清山', '五指山', '中原', '江南', '江东', '关东', '太原', '洛阳', '长沙', '南阳',
  '襄阳', '岳阳', '衡阳', '信阳', '贵阳', '江陵', '金陵', '天水', '武威', '张掖', '酒泉', '敦煌', '玉门', '大理', '丽江', '九江', '镇江',
  '宁波', '温州', '扬州', '徐州', '常州', '泉州', '漳州', '惠州', '德州', '锦州', '通州', '荆州', '河内', '阿尔泰', '喀拉库姆',
  '克孜勒库姆', '安西', '北庭', '咸阳', '开封', '临安', '长安', '汴梁', '邯郸', '大庆', '大同', '大连', '伊犁', '亚西亚', '尼西亚',
  // 单独出现像现实里的专名
  '阿里', '阿拉', '大金',
  // 普通词,单独当名字太平淡
  '平原', '高原', '草原', '沧海',
]);

const words = (s: string) => s.split(/\s+/);

/** 拉丁原形:整词屏蔽 */
const BLOCKED_LATIN_EXACT = new Set([
  // 现实地名(含古地名)
  ...words(
    'albania romania armenia bulgaria serbia croatia slovenia slovakia bosnia latvia lithuania estonia georgia austria australia ' +
      'russia prussia scandia iberia italia hispania gallia britannia germania dacia thracia moravia bohemia silesia galicia ' +
      'andalusia catalonia castilia castile valencia valentia venezia liguria etruria umbria calabria sardinia sicilia corsica ' +
      'lusitania cambria caledonia hibernia numidia mauritania libya nigeria algeria tunisia syria assyria arabia persia india ' +
      'macedonia moldavia moldova wallachia transylvania pannonia anatolia lydia phrygia cappadocia cilicia arcadia achaea attica ' +
      'laconia colombia bolivia venezuela patagonia tasmania virginia california carolina columbia philadelphia olympia ' +
      'alexandria ilion calais ' +
      'rome roma paris london berlin vienna venice verona milan milano naples napoli florence genoa ravenna sparta athens thebes ' +
      'corinth delphi troy troya rhodes crete knossos argos delos naxos samos ithaca ithaka kos patmos lesbos chios mykonos ' +
      'sahara cairo baghdad damascus basra mosul medina mecca tehran kabul samarkand bukhara tashkent kazan moscow kiev kyiv minsk ' +
      'omsk tomsk smolensk novgorod belgrade zagreb sofia prague warsaw krakow oslo bergen stockholm uppsala copenhagen aalborg ' +
      'reykjavik narvik tromso helsinki turku riga tallinn vilnius hamburg luxembourg strasbourg bordeaux lyon marseille nantes ' +
      'orleans york kent essex wessex sussex cornwall devon dover oxford cambridge bristol leeds ashford ashton brighton preston ' +
      'boston camden hampton lancaster chester manchester winchester dorchester kingston richmond portsmouth plymouth dartmouth ' +
      'norway sweden denmark finland iceland holland ireland scotland england poland lapland ukraine latvia',
  ),
  // 由现实地名来的词(民族、语言、海域)
  ...words(
    'korean persian indian caspian arabian iranian iraqi syrian egyptian turkish mongolian tibetan chinese japanese ' +
      'european american african asian russian german french english spanish italian roman greek irish scottish welsh ' +
      'caribbean mediterranean baltic aegean adriatic ionian arctic antarctic pacific atlantic',
  ),
  // 现实里常见的人名
  ...words('maria anna diana elena helena sara sarah lara laura clara nina vera irina olga natasha tatiana sonia julia livia'),
  // 现实人名、政治称呼
  ...words('hitler stalin lenin nazi'),
  // 宗教与神话
  ...words(
    'allah jesus christ buddha kaaba satan lucifer atlantis avalon lemuria hyperborea ' +
      'midgard asgard jotunheim helheim vanaheim niflheim muspelheim utgard',
  ),
  // 他人作品里的名字
  ...words(
    'narnia westeros essos tamriel skyrim hyrule azeroth kalimdor lordaeron dalaran stratholme quelthalas ' +
      'gondor mordor rohan arnor lorien rivendell isengard moria valinor valmar numenor eriador beleriand doriath gondolin lindon erebor eregion',
  ),
  // 骂人的词(编码存储)
  ...words(decode('bW9yb24gaWRpb3Q=')),
]);

/** 拉丁原形:出现在任何位置都屏蔽的片段(多种语言的脏话、蔑称、不吉利的词;编码存储) */
const BLOCKED_LATIN_SUBSTR = decode(
  'ZnVjayBzaGl0IGN1bnQgZGljayBjb2NrIHBpc3MgYW51cyBhbmFsIHBvcm4gc2V4IG5pZyBmYWcgcmFwZSBzbHV0IHdob3JlIHBlbmlzIHZhZ2lu' +
    'IHNlbWVuIGN1bSB0dXJkIGFyc2Uga3Vyd2EgYmx5YXQgYmx5YWQgc3VrYSBwaXpkIGh1eSBraHVpIGtrayBuYXppIHBvb3AgdGl0cyBib29iIGJ1' +
    'dHQgZGFtbiBoZWxsIGtpbGwgZGVhZCBraWtlIHNwaWMgdHdhdCB3YW5rIGJpdGNoIGJhc3RhcmQgcmV0YXJk',
).split(' ');

export function zhBlocked(zh: string): boolean {
  for (const ch of zh) if (BLOCKED_CHARS.has(ch)) return true;
  if (BLOCKED_EXACT.has(zh)) return true;
  for (const s of BLOCKED_SUBSTR) if (zh.includes(s)) return true;
  // 同一个字紧挨着重复(卡卡、拉拉)读起来像叠词;两字一组重复(莫尔莫尔)像口吃
  const chars = [...zh];
  for (let i = 1; i < chars.length; i++) if (chars[i] === chars[i - 1]) return true;
  for (let i = 0; i + 3 < chars.length; i++) if (chars[i] === chars[i + 2] && chars[i + 1] === chars[i + 3]) return true;
  return false;
}

export function latinBlocked(latin: string): boolean {
  const w = latin.toLowerCase().replace(/[^a-z ]/g, '');
  for (const part of w.split(' ')) if (BLOCKED_LATIN_EXACT.has(part)) return true;
  const joined = w.replace(/ /g, '');
  for (const s of BLOCKED_LATIN_SUBSTR) if (joined.includes(s)) return true;
  return false;
}

/** 单测用:导出屏蔽字 / 组合,检查生成结果 */
export const BLOCKLIST_FOR_TEST = { chars: BLOCKED_CHARS, substr: BLOCKED_SUBSTR, exact: BLOCKED_EXACT };
