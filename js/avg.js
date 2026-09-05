// avg.js — 橙光 App（互动文字游戏引擎 + 《校园皆是修罗场》《谍影留声》游戏定义）

(function() {
  var SAVE_SLOT = 1
  var AVG_VERSION = 'v1.1.0'
  var CUSTOM_ROLES_KEY = 'customRoles'   // avgConfigs 中自建角色列表（两作共用，不加前缀）
  var HISTORY_LIMIT = 16          // 请求携带的最近上下文条数
  var CHAPTER_TURN_HARD_CAP = 12  // 单章保底轮数上限，避免卡章
  var AUTO_RETRY_MAX = 2          // 空回/格式失败时的自动重试次数

  function esc(str) {
    if (window.escapeMainHtml) return window.escapeMainHtml(str)
    return String(str == null ? '' : str).replace(/[&<>"']/g, function(ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    })
  }

  function toast(msg) { window.toast && window.toast(msg) }

  function clamp(n, min, max) {
    n = Number(n)
    if (!isFinite(n)) return min
    return Math.max(min, Math.min(max, n))
  }

  function timeAgoText(ts) {
    if (!ts) return '未开始'
    var diff = Date.now() - ts
    var minute = 60000, hour = 3600000, day = 86400000
    if (diff < minute) return '上次游玩 · 刚刚'
    if (diff < hour) return '上次游玩 · ' + Math.floor(diff / minute) + ' 分钟前'
    if (diff < day) return '上次游玩 · ' + Math.floor(diff / hour) + ' 小时前'
    if (diff < day * 30) return '上次游玩 · ' + Math.floor(diff / day) + ' 天前'
    var d = new Date(ts)
    return '上次游玩 · ' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
  }

  // 首字占位 + 头像图：图加载成功盖住占位，失败时 onerror 移除自己露出首字
  function avatarHTML(name, avatar) {
    var letter = '<span class="avg-ava-letter">' + esc(String(name || '?').charAt(0)) + '</span>'
    var img = avatar ? '<img src="' + esc(avatar) + '" alt="" onerror="this.remove()">' : ''
    return letter + img
  }

  function tagsHTML(tags) {
    if (!tags || !tags.length) return ''
    return '<div class="avg-tags">' + tags.map(function(t) {
      return '<span class="avg-tag">' + esc(t) + '</span>'
    }).join('') + '</div>'
  }

  function normalizeTags(raw) {
    if (!Array.isArray(raw)) return []
    return raw.map(function(t) { return String(t || '').trim().slice(0, 6) })
      .filter(Boolean).slice(0, 5)
  }

  // 立绘压缩：等比缩到最长边 1024，PNG 保留透明背景；http(s) 地址原样保留
  function compressSpriteImage(source) {
    return new Promise(function(resolve) {
      var value = String(source || '').trim()
      if (!value || /^https?:\/\//i.test(value)) { resolve(value); return }
      var image = new Image()
      image.onload = function() {
        try {
          var maxSide = 1024
          var w = image.naturalWidth || 1
          var h = image.naturalHeight || 1
          var scale = Math.min(1, maxSide / Math.max(w, h))
          var canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(w * scale))
          canvas.height = Math.max(1, Math.round(h * scale))
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL('image/png'))
        } catch (_) { resolve(value) }
      }
      image.onerror = function() { resolve('') }
      image.src = value
    })
  }

  // ===== avgConfigs 键值读写 =====
  async function getAvgConfig(key, fallback) {
    try {
      var row = await db.avgConfigs.get(key)
      return row ? row.value : fallback
    } catch (_) { return fallback }
  }

  async function setAvgConfig(key, value) {
    await db.avgConfigs.put({ key: key, value: value })
  }

  // ===== 当前游戏定义（进入游戏卡片时设置，所有页面/引擎逻辑经 G 取参数） =====
  var G = null

  // 按游戏加前缀的 avgConfigs 键（《校园》沿用无前缀历史键，《谍影》为 shadow:）
  function gk(key) { return G.cfgPrefix + key }

  // ===== 存档读写（单槽自动存档） =====
  async function loadSave() {
    return await db.avgSaves.where('gameId').equals(G.id)
      .and(function(s) { return s.slot === SAVE_SLOT }).first()
  }

  async function writeSave(save) {
    save.updatedAt = Date.now()
    if (save.id != null) {
      await db.avgSaves.put(save)
    } else {
      save.id = await db.avgSaves.add(save)
    }
    await setAvgConfig(gk('lastPlayedAt'), save.updatedAt)
  }

  async function deleteSave() {
    var save = await loadSave()
    if (save && save.id != null) await db.avgSaves.delete(save.id)
  }

  function maxFavor(save) {
    return save.characters.reduce(function(m, c) { return Math.max(m, c.favor || 0) }, 0)
  }

  function mainCharacter(save) {
    return save.characters.reduce(function(best, c) {
      return (!best || (c.favor || 0) > (best.favor || 0)) ? c : best
    }, null)
  }

  // ===================================================================
  // 游戏定义 ①《校园皆是修罗场》
  // （导演指令原文见 prompt-local/橙光-校园皆是修罗场-设计.md §5.3）
  // ===================================================================

  // 内置角色（人设已是大学生设定，导入时跳过校园化改编）
  // 头像图由用户按 prompt-local/橙光-内置角色头像生成词.md 生成后放入 img/avg/
  var CAMPUS_PRESETS = [
    {
      presetId: 'ava01',
      name: '沈倦',
      gender: '男',
      tags: ['高冷', '毒舌', '学神', '失眠', '外冷内热'],
      avatar: 'img/avg/ava01-campus.png',
      persona: '大二数学系第一名，常年霸榜的学神。白发是熬夜和天生发色的共同结果，鼻梁上总贴着一枚创可贴——问就是「摔的」，没人敢问第二次。说话极简且毒舌，能用三个字让人闭嘴，但讲题时意外地有耐心。失眠严重，早八永远压线进教室，坐下就闭目养神。对陌生同学态度冷淡，除非你拿着一道他没见过的题。传闻他拒绝过校刊三次专访，也拒绝过整个年级的表白。'
    },
    {
      presetId: 'ava02',
      name: '纪星回',
      gender: '男',
      tags: ['痞帅', '猫系', '主唱', '自来熟', '怕水'],
      avatar: 'img/avg/ava02-campus.png',
      persona: '大二音乐系，地下乐队「九命」的主唱兼吉他手。黑发凌乱，永远别着一枚猫耳发夹——粉丝送的，戴上就没摘过。细框眼镜配银链，笑起来眼尾上挑，像只慵懒的猫。自来熟，第一次见面就敢给你起外号，但被摸头会炸毛。排练室常驻，逃课记录辉煌，考前突击却总能过。怕水，体育课游泳单元靠装病混过去。传闻他写过一首没发表的歌，歌名是一个人的名字。'
    },
    {
      presetId: 'ava03',
      name: '陆时衍',
      gender: '男',
      tags: ['腹黑', '会长', '家世显赫', '温柔刀', '控制欲'],
      avatar: 'img/avg/ava03-campus.png',
      persona: '大二经管学院，学生会主席。陆氏集团独子，本人对此闭口不提，但全校都知道。衬衫永远熨帖，笑容标准得像海报，说出的话却总在三天后才让人品出深意。擅长把「为你好」和「按我说的做」缝在一起，温柔刀法炉火纯青。记性极好，你随口提过的话他会在关键时刻原样奉还。对陌生同学礼貌周到，礼貌得让人有距离。传闻学生会没有人敢和他单独乘电梯。'
    },
    {
      presetId: 'ava04',
      name: '池野',
      gender: '男',
      tags: ['阳光', '体育生', '奶狗', '大嗓门', '路痴'],
      avatar: 'img/avg/ava04-campus.png',
      persona: '大二体育学院短跑特长生，校运会百米纪录保持者。小麦色皮肤，笑容比正午太阳还晃眼，嗓门大到隔着操场都能听见他喊你名字。精力过剩，永远在跑步、投篮和找人吃饭三件事之间循环。重度路痴，开学两个月还会在教学楼迷路，需要人带。对谁都热情，但只会把跑完八百米的第一口水递给一个人。传闻他手机屏保是张模糊的偷拍，没人看清过拍的是谁。'
    },
    {
      presetId: 'ava05',
      name: '晏初雪',
      gender: '女',
      tags: ['清冷', '学霸', '钢琴', '慢热', '女神'],
      avatar: 'img/avg/ava05-campus.png',
      persona: '大二中文系，绩点与颜值双榜第一，人称「初雪女神」。黑长直，说话轻声细语但句句有分量，拒绝人时眼睛都不眨。琴房常客，弹肖邦的时候整层楼都会安静。慢热，做朋友三年也未必知道她家住哪，但会默默记住你不吃香菜。对陌生同学保持礼貌的两米距离，靠近一步都算破例。传闻她抽屉里锁着一沓没寄出去的信，收信人栏全部空白。'
    },
    {
      presetId: 'ava06',
      name: '江晚棠',
      gender: '女',
      tags: ['飒爽', '毒舌', '消息通', '仗义', '嗜辣'],
      avatar: 'img/avg/ava06-campus.png',
      persona: '大二新闻系，校园十大风云人物之首。红唇加高马尾，走路带风，消息灵通到教务处换打印机她都第一个知道。毒舌但分人，怼起讨厌鬼字字见血，护起朋友寸步不让。饭搭子首选，无辣不欢，实验室辣度挑战纪录保持者。看似社交花蝴蝶，实际交心的名单短得可怜。对陌生同学自来熟，三句话套出你的星座和课表。传闻她拒绝了隔壁校草七次，理由每次都不重样。'
    }
  ]

  var CAMPUS_GAME = {
    id: 'campus-shura',
    cfgPrefix: '',
    title: '校园皆是修罗场',
    titleEn: 'CAMPUS CRUSH',
    img: {
      cover: 'img/avg/cover-campus.png',
      bg: 'img/avg/background-campus.png',
      sprite: 'img/avg/character-campus.png'
    },
    bgmId: '1304926227',
    relationLabel: '座位关系',
    relations: ['同桌', '前桌', '后桌', '隔壁组'],
    statKeys: ['心机', '人缘', '魅力', '成绩'],
    initialStats: { '心机': 10, '人缘': 10, '魅力': 10, '成绩': 10 },
    hasSuspicion: false,
    emotions: 'shy|angry|calm|smirk|jealous',
    statExample: '心机',
    adaptedWord: '校园化',
    importTitle: '选择同班同学',
    importHint: '共选 3-5 名 · 性别不限 · 点选后可切换座位关系',
    adaptTip: '每位角色的身份统一为「大学同班同学」，性格与说话方式完整保留。生成结果可手动微调或选择重新生成。与角色档案完全分离，仅作为本次存档的人设。',
    bgHint: '建议横版大图；上传后替换默认教室背景',
    presetRoles: CAMPUS_PRESETS,

    // 攻略阶段文案（对应全局 Prompt 的好感度区间）
    favorStageText: function(favor) {
      favor = favor || 0
      if (favor >= 80) return '不计代价'
      if (favor >= 60) return '占有欲与主动出击'
      if (favor >= 40) return '明显偏爱、开始吃醋'
      if (favor >= 20) return '留意在乎'
      return '陌生礼貌'
    },

    openingAction: function(save) {
      return '【开局】主角' + save.player.name + '刚转入班级，请生成序章开场剧情与选项。'
    },

    promptIntro: function(save) {
      return '你是橙光风格校园恋爱互动游戏《校园皆是修罗场》的剧情引擎。\n\n' +
        '【世界观】现代大学，主角' + save.player.name + '（' + save.player.gender + '）刚转入某大学二年级（3）班，\n' +
        '该专业实行固定教室上课，主角的座位被几位性格迥异的同学包围。\n' +
        '剧情基调：青春、暧昧、暗流涌动的多角修罗场，可甜可虐，\n' +
        '但不出现露骨内容与真实校园暴力细节。'
    },

    favorStages: '0-19 陌生礼貌 / 20-39 留意在乎 / 40-59 明显偏爱、开始吃醋 / 60-79 占有欲与主动出击 / 80+ 不计代价。',
    dramaRule: '修罗场值 ≥60 时，高好感角色之间必须出现正面交锋（抢话、阴阳怪气、肢体挡人等）。',

    writingRules: '1. 旁白第二人称「你」，细腻但简洁，单轮总字数 300-500 字；\n' +
      '2. 台词符合大学生语感，带小动作描写；每轮至少让 2 名角色出场或被提及；\n' +
      '3. 每轮给出 2-4 个选项：至少 1 个偏向不同角色，至少 1 个影响主角属性；\n' +
      '   选项后果要有差异，不许出现「换皮同义」选项；\n' +
      '4. 数值变化克制：单选项好感 -8~+8、属性 -5~+5、修罗场 0~+6；\n' +
      '5. 剧情必须服从【本章导演指令】的走向与禁止事项；\n' +
      '6. 只输出 JSON，格式见【输出格式】，不要输出任何其他文字。',

    // §5.0 角色校园化 Prompt（导入时逐角色调用一次）
    buildAdaptPrompt: function(ch) {
      return '你是角色档案改编助手。请把下面这个角色改编为互动游戏《校园皆是修罗场》\n' +
        '中的角色：现代大学校园，与主角同班的大学生。\n\n' +
        '【原始档案】\n' +
        '名字：' + ch.name + '\n' +
        '性别：' + (ch.gender || '（空）') + '\n' +
        '人设：' + (ch.persona || '（无）') + '\n\n' +
        '【改编规则】\n' +
        '1. 只允许改写「人设」。名字由系统直接沿用原档案，你不需要处理名字，\n' +
        '   改编后的人设中提及该角色时必须用原名，不要起外号；\n' +
        '2. 性别：原档案已给出性别时，原样保留、禁止更改；\n' +
        '   仅当性别为空时，阅读人设自行判定一个最贴合的性别并填入；\n' +
        '3. 身份落位：无论原设是总裁、皇帝、杀手、神明、异世界人……一律改编为\n' +
        '   「同班大学生」，并给出合理的校园化对应（总裁→家里有集团的大学生/学生会主席，\n' +
        '   古代将军→体育特长生/国防生，神医→医学部跨系来蹭课的学霸等），\n' +
        '   原设中的核心背景可保留为「家世/经历/传闻」，但当前身份必须是在读大学生；\n' +
        '4. 性格完整保留：说话方式、口癖、癖好、雷点、喜好全部保留，不许洗白或降智；\n' +
        '   与校园无关的能力设定（超能力、武功等）改写为对应的特长或删除；\n' +
        '5. 改编后人设 150-300 字，包含：校园身份（年级/专业/社团或身份标签）、\n' +
        '   性格与说话方式、对陌生同学的初始态度、1-2 个可用于剧情的小习惯或传闻；\n' +
        '6. 同时提炼 3-5 个性格标签：每个 2-4 字的短词（如「高冷」「毒舌」「奶狗」），\n' +
        '   概括性格与人设记忆点，不要重复近义词。\n\n' +
        '【输出格式】只输出 JSON，不要其他文字：\n' +
        '{ "gender": "男|女（按规则2）", "persona": "改编后的校园人设", "tags": ["标签1", "标签2", "标签3"] }'
    },

    chapters: [
      {
        name: '序章 · 转学第一天',
        favorCap: 25,
        directive: '【本章导演指令 · 序章】\n' +
          '走向：主角转学报到→自我介绍→安排座位→与每位角色发生一次「初见事件」\n' +
          '（借笔、撞肩、被认错人、递错情书等，每人一个，风格差异要大）。\n' +
          '节奏：轻快日常，暧昧只许若有似无。\n' +
          '禁止：任何角色好感表现超过「留意」级；禁止冲突事件；禁止告白。\n' +
          '数值范围：本章内单角色好感不得超过 25。',
        endEvent: '【章末事件指令】放学时下雨，只有一个人「恰好」多带了伞——由当前好感最高者触发，\n' +
          '其他角色目击，埋下修罗场种子。请演出该事件并收束本章，本轮不给选项（choices 为空数组），progress.eventDone 置 true。',
        checkEnd: function(save) {
          var met = save.metCharacters || []
          return met.length >= save.characters.length && save.chapterTurns >= save.characters.length
        }
      },
      {
        name: '第一章 · 座位攻防战',
        favorCap: 45,
        directive: '【本章导演指令 · 第一章】\n' +
          '走向：期中考后班级调座位传闻四起→各角色用各自方式争取/维持靠近主角的位置\n' +
          '（学霸型用成绩谈判、体育型直接找辅导员、腹黑型使小手段）→穿插 2-3 个双人独处小事件。\n' +
          '节奏：竞争感上升，允许角色间轻微较劲（口头、抢占先机），但仍维持表面和平。\n' +
          '必须触发：至少一次「两名角色同时向主角示好、主角必须二选一」的选项轮。\n' +
          '禁止：正面撕破脸；告白；任何角色退场。\n' +
          '数值范围：允许好感冲到 45；修罗场值本章应升至 20-35。',
        endEvent: '【章末事件指令】座位调整公布，结果偏向玩家累计选择最多的角色；\n' +
          '落选角色留下一句意味深长的话作为下章引子。请演出该事件并收束本章，本轮不给选项（choices 为空数组），progress.eventDone 置 true。',
        checkEnd: function(save) {
          return maxFavor(save) >= 30 && save.chapterTurns >= 4
        }
      },
      {
        name: '第二章 · 纸条与绯闻',
        favorCap: 60,
        directive: '【本章导演指令 · 第二章】\n' +
          '走向：一张匿名纸条/一则绯闻在班里流传（内容与主角有关）→各角色反应分化：\n' +
          '有人信、有人查、有人吃醋、有人将计就计→主角选择澄清方式决定人缘与心机走向。\n' +
          '节奏：暗流变明流。高好感角色（≥40）必须表现出吃醋与试探，允许阴阳怪气、\n' +
          '课间堵人、故意在主角面前较劲。\n' +
          '必须触发：一次三人以上同场的尴尬修罗场面（如食堂拼桌、小组作业分组、体育课分组）。\n' +
          '禁止：肢体冲突升级到打架；角色黑化到不可挽回。\n' +
          '数值范围：允许好感冲到 60；修罗场值应升至 40-60。',
        endEvent: '【章末事件指令】绯闻源头揭晓——与其中一名角色有关（选好感第二高者，制造张力），\n' +
          '主角获得「原谅/疏远/利用」三向选择（本轮 choices 必须正好是这三个方向），直接影响该角色终章走向。progress.eventDone 置 true。',
        checkEnd: function(save) {
          return save.drama >= 40 && save.chapterTurns >= 4
        }
      },
      {
        name: '第三章 · 摊牌前夜',
        favorCap: 85,
        directive: '【本章导演指令 · 第三章】\n' +
          '走向：校运会/校园文化节筹备期→主线角色（当前好感最高者）发起接近攻势，\n' +
          '其余角色做最后争取或体面退出→安排一次主线角色的「脆弱面」独处事件\n' +
          '（受伤、家事、旧照片等，深化羁绊）。\n' +
          '节奏：情感浓度最高的一章，允许暧昧直球：递水、系鞋带、天台谈心、耳机分你一只。\n' +
          '必须触发：一次「其他角色目击主角与主线角色独处」的修罗场事件，\n' +
          '目击者反应按其好感与性格分化（祝福/死缠/黑化倾向）。\n' +
          '禁止：正式告白成功（留给终章）；主线角色 OOC 式突然冷淡。\n' +
          '数值范围：主线角色好感应推到 60-80；修罗场值 50-75。',
        endEvent: '【章末事件指令】主线角色约主角「明天放学后，天台见」；\n' +
          '当晚其余高好感角色各发出一条动摇信息（短信/纸条）。请演出该事件并收束本章，本轮不给选项（choices 为空数组），progress.eventDone 置 true。',
        checkEnd: function(save) {
          return maxFavor(save) >= 60 && save.chapterTurns >= 4
        }
      },
      {
        name: '终章 · 天台答案',
        favorCap: 100,
        directive: '',  // 运行时由 buildEndingDirective 生成
        endEvent: '',   // 终章的收束即结局演出
        checkEnd: function(save) {
          return save.chapterTurns >= 2
        }
      }
    ],

    // ===== 结局判定（§4 / §5.3 终章） =====
    computeEnding: function(save) {
      var main = mainCharacter(save)
      var favor = main ? (main.favor || 0) : 0
      var drama = save.drama || 0
      var scheming = (save.stats && save.stats['心机']) || 0
      if (favor >= 80 && drama < 70) return { code: 'HE', label: 'HE（告白成功）', main: main }
      if (favor >= 80 && drama >= 70) return { code: 'SHURA_HE', label: '修罗场 HE（闹剧式圆满）', main: main }
      if (favor >= 60 && favor <= 79 && scheming >= 70) return { code: 'BE', label: 'BE（被看穿算计）', main: main }
      return { code: 'NE', label: 'NE（朋友以上，毕业留白）', main: main }
    },

    buildEndingDirective: function(save) {
      var ending = CAMPUS_GAME.computeEnding(save)
      var main = ending.main
      return '【本章导演指令 · 终章】\n' +
        '走向：天台赴约→按下方系统已判定的结局线演出，本章选项减少（1-2 轮），以演出为主。\n' +
        '系统判定结果（必须严格照此演出，不得自行改线）：\n' +
        '- 主线角色：' + (main ? main.name : '（无）') + '（当前好感 ' + (main ? main.favor : 0) + '）\n' +
        '- 结局线：' + ending.label + '\n' +
        '写作要求：结局 600-900 字，回收前四章至少 3 个伏笔（雨伞、纸条、座位、耳机等），\n' +
        '末尾附一句「' + (main ? main.name : 'XX') + '线 · 结局达成」标题式收束。\n' +
        '禁止：新增角色；新增未铺垫的反转。'
    }
  }

  // ===================================================================
  // 游戏定义 ②《谍影留声》
  // （导演指令原文见 prompt-local/橙光-谍影留声-设计.md §5.3）
  // ===================================================================

  // 内置角色（人设已是民国设定，导入时跳过民国化改编）
  // 头像图由用户按 prompt-local/橙光-内置角色头像生成词.md 生成后放入 img/avg/
  var SHADOW_PRESETS = [
    {
      presetId: 'ava01-shadow',
      name: '霍砚清',
      gender: '男',
      relation: 0,   // 当权者
      tags: ['冷峻', '掌权', '洁癖', '护短', '外冷内热'],
      avatar: 'img/avg/ava01-shadow.png',
      persona: '警备司令部情报处上校处长，三十岁上下，军装永远一丝不苟，白手套换得比说的话还勤。租界内人人知道他的名字，却没人敢在他面前提他的家事。说话短，问话更短，一句「说重点」能让整间审讯室安静。有洁癖，翻过案卷必用手帕擦手；深夜办公室的灯常亮到两三点。对陌生人只有审视，没有寒暄——但被他记住名字的人，往往会在意想不到的时候得到一把伞，或一条生路。传闻他书房里锁着一张旧照片，谁问起，谁第二天就被调岗。'
    },
    {
      presetId: 'ava02-shadow',
      name: '白景珩',
      gender: '男',
      relation: 1,   // 世家
      tags: ['风流', '阔绰', '毒舌', '念旧'],
      avatar: 'img/avg/ava02-shadow.png',
      persona: '白氏洋行少东家，沪上小报的常客，舞会请柬比名片发得还多。西装口袋永远别一支白玫瑰，笑起来漫不经心，毒舌起来让人接不上话，偏偏挑不出错处。挥金如土，却对一只用旧的怀表格外上心，表盖内侧刻着一个模糊的字。看似谁都能凑近，实则谁也没真正走进过他的书房。对陌生人热情周到，热情得像隔着一层玻璃。传闻白家的生意近来在悄悄向香港转移，问他，他只笑着替你斟酒换话题。'
    },
    {
      presetId: 'ava03-shadow',
      name: '沈疏影',
      gender: '女',
      relation: 2,   // 同行者
      tags: ['机敏', '口风紧', '嗜甜', '仗义'],
      avatar: 'img/avg/ava03-shadow.png',
      persona: '《申报》社会版记者兼夜班电讯员，利落短发上别着一支钢笔，走路带风。消息灵得吓人，警局换了个门房她都第一个知道，可要从她嘴里撬出一个字比登天还难。嗜甜，抽屉里永远囤着话梅糖，紧张的时候会剥一颗含着。对同事仗义，谁被克扣稿费她第一个拍桌子。深夜的电讯室常见她的灯——发的究竟是新闻稿还是别的什么，没人核对过。对陌生人三分热络七分打量，握手时会不动声色地看你的指茧。传闻她抽屉最底层压着一张空白的船票。'
    },
    {
      presetId: 'ava04-shadow',
      name: '聂云笙',
      gender: '男',
      relation: 3,   // 局外人
      tags: ['温润', '博学', '疏离', '怕吵'],
      avatar: 'img/avg/ava04-shadow.png',
      persona: '仁济医院的外科医生，留法七年，一口软糯的江南官话里偶尔蹦出法文单词。白大褂下永远是熨帖的三件套，手稳，话轻，笑起来让人想起春天的诊室。医术好到租界各方都卖他面子，他却谁的宴请都推，说「病人比酒局要紧」。怕吵，诊室里连座钟都挑走针最轻的一台。对陌生人温和有礼，但礼貌就是他的墙。会拉一手很好的大提琴，只在深夜无人的病房区拉。传闻他留法期间参加过什么组织，问起来他只说「学生时代的事，记不清了」。'
    },
    {
      presetId: 'ava05-shadow',
      name: '苏曼卿',
      gender: '女',
      relation: 4,   // 暗处者
      tags: ['妩媚', '神秘', '善变', '重情'],
      avatar: 'img/avg/ava05-shadow.png',
      persona: '百乐门当红歌女，一首《夜来香》唱得半个上海失眠。旗袍开衩永远比别人高半寸，笑起来眼波流转，谁也读不出真假。来历成谜——有人说她从北平来，有人说她根本不姓苏。记性好得可怕，客人三个月前随口说的话，她能原样唱进歌里。善变，前一刻还倚着钢琴笑，下一刻就能冷着脸让经理换掉整支乐队。对陌生人先递三分笑，剩下七分要看你值不值。化妆间不许任何人进，桌上永远摆着一台老式留声机，唱片从不示人。传闻散场后有黑色轿车来接她，车牌每次都不一样。'
    }
  ]

  var SHADOW_GAME = {
    id: 'echoes-shadow',
    cfgPrefix: 'shadow:',
    title: '谍影留声',
    titleEn: 'ECHOES OF SHADOWS',
    img: {
      cover: 'img/avg/cover-shadow.png',
      bg: 'img/avg/background-shadow.png',
      sprite: 'img/avg/character-shadow.png'
    },
    bgmId: '5059144',
    relationLabel: '立场关系',
    relations: ['当权者', '世家', '同行者', '局外人', '暗处者'],
    statKeys: ['伪装', '交际', '情报', '胆识'],
    initialStats: { '伪装': 10, '交际': 10, '情报': 10, '胆识': 10 },
    hasSuspicion: true,
    emotions: 'shy|angry|calm|smirk|jealous|wary',
    statExample: '伪装',
    adaptedWord: '民国化',
    importTitle: '选择攻略对象',
    importHint: '共选 3-5 名 · 性别不限 · 点选后可切换立场关系；立场越分散，修罗场越好看',
    adaptTip: '每位角色统一改编为 1937 年上海的民国人物，身份与其立场关系相称，性格与说话方式完整保留。生成结果可手动微调或选择重新生成。与角色档案完全分离，仅作为本次存档的人设。',
    bgHint: '建议横版大图；上传后替换默认雨夜街景背景',
    presetRoles: SHADOW_PRESETS,

    // 攻略阶段文案（对应全局 Prompt 的好感度区间）
    favorStageText: function(favor) {
      favor = favor || 0
      if (favor >= 80) return '可以为主角背叛立场'
      if (favor >= 60) return '占有欲并起、排除情敌'
      if (favor >= 40) return '明显偏爱、开始破例'
      if (favor >= 20) return '留意与试探'
      return '可利用的陌生人'
    },

    openingAction: function(save) {
      return '【开局】主角' + save.player.name + '初到上海报到，入职百乐门与报馆，请生成序章开场剧情与选项。'
    },

    promptIntro: function(save) {
      return '你是橙光风格民国谍战恋爱互动游戏《谍影留声》的剧情引擎。\n\n' +
        '【世界观】1937 年前后的上海租界。主角' + save.player.name + '（' + save.player.gender + '）明面上是\n' +
        '百乐门新来的琴师兼报馆见习记者，实为地下情报网的外围联络员，代号「夜莺」。\n' +
        '剧情基调：乱世浮华、暧昧与试探并存的多角修罗场，恋爱为主、谍战为骨，\n' +
        '可甜可虐，但不出现露骨内容、酷刑细节与真实历史人物。'
    },

    favorStages: '0-19 视作可利用的陌生人 / 20-39 留意与试探 / 40-59 明显偏爱、开始为主角破例 /\n' +
      '60-79 占有欲与保护欲并起、主动排除情敌 / 80+ 可以为主角背叛立场。',
    dramaRule: '修罗场值 ≥60 时，高好感角色之间必须出现正面交锋（舞池抢舞伴、席间夹枪带棒、\n' +
      '以权势或情报互相牵制等）。',

    writingRules: '1. 旁白第二人称「你」，带民国氛围细节（留声机、黄包车、霓虹、雨巷），\n' +
      '   细腻但简洁，单轮总字数 300-500 字；\n' +
      '2. 台词符合各角色身份与时代语感，带小动作描写；每轮至少让 2 名角色出场或被提及；\n' +
      '3. 每轮给出 2-4 个选项：至少 1 个偏向不同角色，至少 1 个影响主角属性；\n' +
      '   选项后果要有差异，不许出现「换皮同义」选项；\n' +
      '4. 数值变化克制：单选项好感 -8~+8、属性 -5~+5、修罗场 0~+6；\n' +
      '5. 剧情必须服从【本章导演指令】的走向与禁止事项；\n' +
      '6. 对主角与攻略对象的性别不做任何假设之外的描写，亲密描写保持含蓄唯美；\n' +
      '7. 只输出 JSON，格式见【输出格式】，不要输出任何其他文字。',

    // §5.0 角色民国化改编 Prompt（导入时逐角色调用一次）
    buildAdaptPrompt: function(ch) {
      return '你是角色档案改编助手。请把下面这个角色改编为互动游戏《谍影留声》\n' +
        '中的角色：1937 年前后的上海，主角在百乐门与报馆间周旋时会反复接触的人物。\n\n' +
        '【原始档案】\n' +
        '名字：' + ch.name + '\n' +
        '性别：' + (ch.gender || '（空）') + '\n' +
        '人设：' + (ch.persona || '（无）') + '\n' +
        '立场关系：' + (ch.seat || '') + '（当权者/世家/同行者/局外人/暗处者）\n\n' +
        '【改编规则】\n' +
        '1. 只允许改写「人设」。名字由系统直接沿用原档案，你不需要处理名字，\n' +
        '   改编后的人设中提及该角色时必须用原名，不要起外号；\n' +
        '2. 性别：原档案已给出性别时，原样保留、禁止更改；\n' +
        '   仅当性别为空时，阅读人设自行判定一个最贴合的性别并填入；\n' +
        '3. 身份落位：无论原设是总裁、大学生、杀手、神明、异世界人……一律改编为\n' +
        '   与其【立场关系】相称的民国身份（当权者→军官/警务处要员，世家→洋行少东/\n' +
        '   旧贵族继承人，同行者→报馆同事/电台报务员，局外人→外籍医生/画家/教授，\n' +
        '   暗处者→来历不明的掮客/舞客），原设核心背景可保留为「家世/经历/传闻」；\n' +
        '4. 现代元素（手机、网络、汽车品牌等）改写为民国等价物（电话、电报、报纸、\n' +
        '   唱片、黄包车等）；性格完整保留：说话方式、口癖、癖好、雷点、喜好\n' +
        '   全部保留，不许洗白或降智；超自然能力改写为对应的特长或删除；\n' +
        '5. 改编后人设 150-300 字，包含：民国身份（职务/家世/在租界的位置）、\n' +
        '   性格与说话方式、对陌生人的初始态度、1-2 个可用于剧情的小习惯或传闻；\n' +
        '6. 同时提炼 3-5 个性格标签：每个 2-4 字的短词（如「腹黑」「毒舌」「洁癖」），\n' +
        '   概括性格与人设记忆点，不要重复近义词。\n\n' +
        '【输出格式】只输出 JSON，不要其他文字：\n' +
        '{ "gender": "男|女（按规则2）", "persona": "改编后的民国人设", "tags": ["标签1", "标签2", "标签3"] }'
    },

    chapters: [
      {
        name: '序章 · 夜莺入沪',
        favorCap: 25,
        directive: '【本章导演指令 · 序章】\n' +
          '走向：主角初到上海报到→接头人只留下一句「先站稳脚跟」→入职百乐门与报馆\n' +
          '→与每位角色发生一次「初见事件」（舞池救场、采访碰壁、雨夜同伞、\n' +
          '错拿大衣、被误认故人等，每人一个，风格差异要大，须与其立场关系呼应）。\n' +
          '节奏：浮华都市的新鲜感 + 若有似无的被注视感，暧昧只许一闪而过。\n' +
          '禁止：任何角色好感表现超过「留意」级；禁止身份危机事件；禁止告白。\n' +
          '数值范围：本章内单角色好感不得超过 25。',
        endEvent: '【章末事件指令】百乐门打烊后主角收到第一封匿名任务信；抬头时发现当前好感最高者「恰好」还没走，\n' +
          '目光在信封上停了一瞬——埋下修罗场与疑心的双重种子。请演出该事件并收束本章，本轮不给选项（choices 为空数组），progress.eventDone 置 true。',
        checkEnd: function(save) {
          var met = save.metCharacters || []
          return met.length >= save.characters.length && save.chapterTurns >= save.characters.length
        }
      },
      {
        name: '第一章 · 舞池与棋局',
        favorCap: 40,
        directive: '【本章导演指令 · 第一章】\n' +
          '走向：主角接到首个正式任务（打探一份货运名单）→各角色以各自方式接近主角\n' +
          '（当权者以「保护」为名安插眼线、世家递出宴会请柬、同行者暗中递话、\n' +
          '局外人提供避风港、暗处者送来来路不明的提示）→穿插 2-3 个双人独处小事件\n' +
          '→本章内须让货运名单任务有个结果（成或败均可）。\n' +
          '节奏：竞争感上升，各角色开始互相打听主角，允许轻微较劲（口头机锋、抢先赴约）。\n' +
          '必须触发：至少一次「两名角色同时向主角发出邀约、主角必须二选一」的选项轮。\n' +
          '禁止：正面撕破脸；告白；主角身份被实质怀疑；任何角色退场。\n' +
          '数值范围：允许好感冲到 40；修罗场值本章应升至 15-30。',
        endEvent: '【章末事件指令】任务收尾当晚，落选邀约的角色在百乐门门口「偶遇」主角，\n' +
          '留下一句意味深长的话作为下章引子。请演出该事件并收束本章，本轮不给选项（choices 为空数组），progress.eventDone 置 true。',
        checkEnd: function(save) {
          return maxFavor(save) >= 30 && save.chapterTurns >= 4
        }
      },
      {
        name: '第二章 · 请柬与耳目',
        favorCap: 55,
        directive: '【本章导演指令 · 第二章】\n' +
          '走向：一场各方势力齐聚的公馆晚宴→主角奉命赴宴窃取一枚印章拓样\n' +
          '→高好感角色（≥40）在宴会上围绕主角明争暗斗：抢第一支舞、挡酒、\n' +
          '借介绍之名互相试探底细→主角的周旋方式决定交际与伪装走向\n' +
          '→晚宴任务须在本章内收尾（得手或惊险脱身二选一）。\n' +
          '节奏：暗流变明流。允许阴阳怪气、当众较劲、借势压人。\n' +
          '必须触发：一次三人以上同场的尴尬修罗场面（舞池、露台或牌桌）。\n' +
          '禁止：暴力冲突；主角任务当场败露；角色黑化到不可挽回。\n' +
          '数值范围：允许好感冲到 55；修罗场值应升至 30-50。',
        endEvent: '【章末事件指令】离场时主角发现拓样信封被人调过包——里面多了一张字条：\n' +
          '「我帮你收了尾。想知道是谁，下周三，国泰影院。」\n' +
          '（字条署名空白，由当前好感第二高者所留，制造张力，本章不揭晓。）\n' +
          '请演出该事件并收束本章，本轮不给选项（choices 为空数组），progress.eventDone 置 true。',
        checkEnd: function(save) {
          return save.drama >= 30 && save.chapterTurns >= 4
        }
      },
      {
        name: '第三章 · 影院暗号',
        favorCap: 65,
        directive: '【本章导演指令 · 第三章】\n' +
          '走向：主角赴影院之约→字条主人揭晓（好感第二高者）→对方摊出「我知道你不简单」\n' +
          '的半张底牌，但动机暧昧：是同路、是招揽、还是只为留住主角本人→\n' +
          '同一时期，主线角色（好感最高者）察觉主角与字条主人来往密切，吃醋与疑虑交织\n' +
          '→穿插一次主角情报任务借助某位角色之力才能完成的事件（借谁由玩家选项决定，\n' +
          '本章内须完成）。\n' +
          '节奏：每句关心都可能是试探，每次试探又掺着真心；心动与警惕并进。\n' +
          '必须触发：一次「主角在两名角色之间传递假话周旋」的选项轮，\n' +
          '选项分别倾向坦诚、隐瞒、反将一军，影响伪装与胆识。\n' +
          '禁止：主角真实身份完全揭穿；任何角色确认主角是地下工作者；告白。\n' +
          '数值范围：允许好感冲到 65；修罗场值应升至 45-60。',
        endEvent: '【章末事件指令】借力任务收尾当晚，帮忙的角色轻描淡写要了一个「人情」——内容暧昧不明\n' +
          '（陪一次晚餐/保留一支舞/一个不许问理由的请求），其余高好感角色透过各自渠道很快知情，\n' +
          '修罗场压力显性化。请演出该事件并收束本章，本轮不给选项（choices 为空数组），progress.eventDone 置 true。',
        checkEnd: function(save) {
          return maxFavor(save) >= 50 && save.chapterTurns >= 5
        }
      },
      {
        name: '第四章 · 绯闻与枪声',
        favorCap: 80,
        directive: '【本章导演指令 · 第四章】\n' +
          '走向：小报登出主角与某位角色（当前好感最高者）的绯闻照片→各角色反应分化：\n' +
          '有人查照片来源、有人吃醋冷战、有人趁虚而入、有人以势压报馆撤稿\n' +
          '→绯闻风波未平，主角所在情报线上的一位同志暴露被捕，组织要求主角暂停一切活动\n' +
          '→主角在「避风头」与「冒险救援/传递关键情报」之间抉择（须在本章内给出选项轮），\n' +
          '胆识与情报属性在此分岔→绯闻以澄清或默认收尾。\n' +
          '节奏：本作最惊险的一章，浪漫与危机交替，允许出现枪声、追车、雨夜转移\n' +
          '（惊险但不血腥）。高好感角色必须在危机中亮出真实态度——护、疑、赌、退，\n' +
          '按其好感与立场关系分化。\n' +
          '必须触发：一次「某角色在危急时刻为主角挡下盘查/追兵」的事件，\n' +
          '由好感最高者触发，其立场关系决定挡的方式（权势/金钱/身份/枪口/调虎离山）。\n' +
          '禁止：主角被捕；任何攻略角色死亡；主角当面承认地下身份。\n' +
          '数值范围：允许好感冲到 80；修罗场值应升至 55-75。',
        // 信物轮：例外不用统一收束句，本轮由玩家表态，选择记入存档 tokens
        endEvent: '【章末事件指令 · 信物轮】风波过后，好感最高者约主角「礼拜六夜里，外白渡桥」；\n' +
          '当晚其余高好感角色各送来一样东西（船票/手枪/药箱/一封未署名的信）。\n' +
          '本轮 choices 为主角对信物的整体态度，必须正好三个方向：\n' +
          '「全部收下」「只收主线角色之外某一人的」「一件不收」，\n' +
          'effects 影响胆识或伪装，progress.eventDone 置 true。',
        endEventChoice: true,
        checkEnd: function(save) {
          return save.drama >= 55 && save.chapterTurns >= 5
        }
      },
      {
        name: '第五章 · 桥头夜话',
        favorCap: 90,
        directive: '【本章导演指令 · 第五章】\n' +
          '走向：外白渡桥夜会→主线角色（好感最高者）摊出自己的底牌\n' +
          '（其真实立场按立场关系生成：当权者早已暗中周旋保人/世家在为撤资转移做准备/\n' +
          '同行者亮明同一条线的身份/局外人打算离沪并发出同行邀请/暗处者揭晓真实雇主）\n' +
          '→并向主角提出一个与终章直接相关的约定→其余角色做最后争取或体面退出\n' +
          '→安排一次主线角色的「脆弱面」独处事件（旧伤、家书、一张泛黄照片等，深化羁绊）。\n' +
          '节奏：情感浓度最高的一章，允许暧昧直球：桥头共伞、留声机独舞、\n' +
          '把大衣披在对方肩上、「等这件事了了，我带你去看海」。\n' +
          '必须触发：一次「其他角色目击主角与主线角色独处」的修罗场事件，\n' +
          '目击者反应按其好感与性格分化（成全/死缠/以情报相要挟的危险倾向）。\n' +
          '禁止：正式告白成功（留给终章）；主线角色 OOC 式突然冷淡；主角身份公开化。\n' +
          '数值范围：主线角色好感应推到 70-90；修罗场值 55-80。',
        endEvent: '【章末事件指令】组织传来最终任务：三日后码头有一批「货」必须送出上海，\n' +
          '主角是唯一能经手的人——而放行的关卡，恰好握在某位攻略角色手里。终章的天平就此立起。\n' +
          '请演出该事件并收束本章，本轮不给选项（choices 为空数组），progress.eventDone 置 true。',
        checkEnd: function(save) {
          return maxFavor(save) >= 65 && save.chapterTurns >= 4
        }
      },
      {
        name: '终章 · 码头与去留',
        favorCap: 100,
        directive: '',  // 运行时由 buildEndingDirective 生成
        endEvent: '',   // 终章的收束即结局演出
        checkEnd: function(save) {
          return save.chapterTurns >= 2
        }
      }
    ],

    // ===== 结局判定（§5.3 终章判定表，自上而下取首个命中） =====
    computeEnding: function(save) {
      var main = mainCharacter(save)
      var favor = main ? (main.favor || 0) : 0
      var drama = save.drama || 0
      var stats = save.stats || {}
      var disguise = stats['伪装'] || 0
      var intel = stats['情报'] || 0
      var guts = stats['胆识'] || 0
      if (favor >= 80 && drama < 70 && disguise >= 60) {
        return { code: 'HE', label: '同渡 HE（并肩同渡）', main: main,
          brief: '任务完成，主线角色与主角同船离沪或原地共守，正式告白成功' }
      }
      if (favor >= 80 && drama >= 70) {
        return { code: 'SHURA_HE', label: '修罗场 HE（闹剧式圆满）', main: main,
          brief: '码头送别变成全员到场的闹剧式圆满，告白被此起彼伏地打断，众人不欢而散又谁都没走远' }
      }
      if (favor >= 80 && disguise < 40) {
        return { code: 'BE_SHORE', label: '隔岸 BE（隔江作别）', main: main,
          brief: '身份在最后一刻暴露，主线角色放走主角却不能同行，隔着江面挥手作别' }
      }
      if (favor >= 60 && favor <= 79 && (disguise >= 70 || intel >= 70)) {
        return { code: 'BE_SEEN', label: '看穿 BE（情深缘浅）', main: main,
          brief: '对方早已看穿主角的接近始于任务，情深缘浅，遗憾错过' }
      }
      if (favor < 60 && guts >= 50) {
        return { code: 'NE_SOLO', label: '孤旅 NE（独自离沪）', main: main,
          brief: '主角独自完成使命离沪，众人成为旧照片' }
      }
      return { code: 'NE_MIST', label: '迷雾 NE（留白收尾）', main: main,
        brief: '任务与感情皆悬而未决，留白式收尾，多年后报纸一角的一则寻人启事作结' }
    },

    buildEndingDirective: function(save) {
      var ending = SHADOW_GAME.computeEnding(save)
      var main = ending.main
      var name = main ? main.name : '（无）'
      return '【本章导演指令 · 终章】\n' +
        '走向：码头之夜，最终任务与感情归属同场结算，本章选项减少（1-2 轮），以演出为主。\n' +
        '系统判定结果（必须严格照此演出，不得自行改线）：\n' +
        '- 主线角色：' + name + '（当前好感 ' + (main ? (main.favor || 0) : 0) + '，立场关系：' + (main ? main.seat : '无') + '）\n' +
        '- 结局线：' + ending.label + ' —— ' + ending.brief + '\n' +
        '- 信物记录：' + (save.tokens || '（无）') + '（演出中回收）\n' +
        '写作要求：结局 600-900 字，回收前六章至少 4 个伏笔\n' +
        '（匿名信、调包字条、那个「人情」、章末信物、桥头约定等），\n' +
        '末尾附一句「' + name + '线 · 结局达成」标题式收束。\n' +
        '禁止：新增角色；新增未铺垫的反转；任何攻略角色死亡。'
    }
  }

  var GAMES = [CAMPUS_GAME, SHADOW_GAME]

  // ===================================================================
  // Prompt 拼装（共用，参数来自当前游戏定义 G）
  // ===================================================================

  // 全局 System Prompt + 输出格式（各作 §5.1 / §5.2）
  function buildSystemPrompt(save) {
    var chapter = G.chapters[save.chapterIndex]
    var directive = save.chapterIndex === G.chapters.length - 1
      ? G.buildEndingDirective(save)
      : chapter.directive
    if (save.pendingChapterEnd && chapter.endEvent) {
      directive += '\n\n' + chapter.endEvent
    }
    var charLines = save.characters.map(function(c) {
      return '- ' + c.name + '（' + (c.gender || '未知') + '，' + G.relationLabel + '：' + c.seat + '）：' + c.persona
    }).join('\n')
    var favorSnapshot = save.characters.map(function(c) {
      return c.name + ' ' + (c.favor || 0)
    }).join('、')
    var statsSnapshot = G.statKeys.map(function(k) {
      return k + ' ' + ((save.stats && save.stats[k]) || 0)
    }).join('、')
    var recapBlock = (save.chapterSummaries && save.chapterSummaries.length)
      ? '【前情提要】以下为已完结章节的剧情摘要，后续剧情必须与之连贯：\n' +
        save.chapterSummaries.map(function(s) {
          return '- ' + s.chapter + '：' + s.text
        }).join('\n') + '\n\n'
      : ''

    return G.promptIntro(save) + '\n\n' +
      '【角色】以下为' + G.adaptedWord + '后的角色档案，性格、说话方式必须严格遵循，不可 OOC：\n' +
      charLines + '\n\n' +
      recapBlock +
      '【当前数值】好感度：' + favorSnapshot + '；主角属性：' + statsSnapshot + '；修罗场值：' + (save.drama || 0) + '。\n' +
      '角色对主角的态度必须与其好感度区间一致：\n' +
      G.favorStages + '\n' +
      G.dramaRule + '\n\n' +
      directive + '\n\n' +
      '【写作要求】\n' +
      G.writingRules + '\n\n' +
      '【输出格式】\n' +
      '{\n' +
      '  "narration": "旁白文本",\n' +
      '  "dialogues": [\n' +
      '    { "speaker": "角色名", "text": "台词", "emotion": "' + G.emotions + '" }\n' +
      '  ],\n' +
      '  "choices": [\n' +
      '    { "text": "选项文案",\n' +
      '      "effects": { "favor": { "角色名": 5 }, "stats": { "' + G.statExample + '": 2 }, "drama": 3 } }\n' +
      '  ],\n' +
      (G.hasSuspicion
        ? '  "suspicion": { "角色名": "低|中|高" },\n'
        : '') +
      '  "progress": { "eventDone": false, "chapterHint": "距章末还差：xxx" }' +
      (save.pendingChapterEnd
        ? ',\n  "chapterLog": { "角色名": "一句话记录本章该角色与主角的关键互动（每个角色都要有，20字以内）" },' +
          '\n  "chapterSummary": "客观概括本章发生的所有关键事件与人物关系变化，120-180字"'
        : '') +
      '\n}'
  }

  // ===================================================================
  // JSON 解析与数值结算
  // ===================================================================
  function parseSceneJSON(raw) {
    var text = String(raw || '').trim()
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    var start = text.indexOf('{')
    var end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    var obj
    try { obj = JSON.parse(text.slice(start, end + 1)) } catch (_) { return null }
    if (!obj || typeof obj !== 'object') return null
    var scene = {
      narration: String(obj.narration || ''),
      dialogues: Array.isArray(obj.dialogues) ? obj.dialogues.filter(function(d) {
        return d && (d.text || d.speaker)
      }).map(function(d) {
        return { speaker: String(d.speaker || ''), text: String(d.text || ''), emotion: String(d.emotion || '') }
      }) : [],
      choices: Array.isArray(obj.choices) ? obj.choices.filter(function(c) {
        return c && c.text
      }).slice(0, 4).map(function(c) {
        return { text: String(c.text), effects: (c.effects && typeof c.effects === 'object') ? c.effects : {} }
      }) : [],
      suspicion: (obj.suspicion && typeof obj.suspicion === 'object') ? obj.suspicion : null,
      progress: (obj.progress && typeof obj.progress === 'object') ? obj.progress : {},
      chapterLog: (obj.chapterLog && typeof obj.chapterLog === 'object') ? obj.chapterLog : null,
      chapterSummary: typeof obj.chapterSummary === 'string' ? obj.chapterSummary.trim() : ''
    }
    if (!scene.narration && !scene.dialogues.length) return null
    return scene
  }

  // 客户端本地结算数值并夹紧（§5.1 规则4 + 章节好感上限）
  function applyEffects(save, effects) {
    effects = effects || {}
    var favorCap = G.chapters[save.chapterIndex].favorCap
    if (effects.favor && typeof effects.favor === 'object') {
      save.characters.forEach(function(c) {
        if (effects.favor[c.name] != null) {
          var delta = clamp(effects.favor[c.name], -8, 8)
          c.favor = clamp((c.favor || 0) + delta, 0, favorCap)
        }
      })
    }
    if (effects.stats && typeof effects.stats === 'object') {
      G.statKeys.forEach(function(k) {
        if (effects.stats[k] != null) {
          var delta = clamp(effects.stats[k], -5, 5)
          save.stats[k] = clamp((save.stats[k] || 0) + delta, 0, 100)
        }
      })
    }
    var dramaDelta = clamp(effects.drama || 0, 0, 6)
    // 自然增长：≥2 名角色好感同时 ≥40 时每轮 +2（§4）
    var hot = save.characters.filter(function(c) { return (c.favor || 0) >= 40 }).length
    if (hot >= 2) dramaDelta += 2
    save.drama = clamp((save.drama || 0) + dramaDelta, 0, 100)
  }

  // 把一幕压缩成历史文本，控制上下文体积
  function compactScene(scene) {
    var parts = []
    if (scene.narration) parts.push('旁白：' + scene.narration)
    scene.dialogues.forEach(function(d) {
      parts.push((d.speaker || '旁白') + '：' + d.text)
    })
    var text = parts.join('\n')
    return text.length > 800 ? text.slice(0, 800) + '……' : text
  }

  // 一幕的完整文本（不截断），用于回顾剧情持久化
  function fullSceneText(scene) {
    var parts = []
    if (scene.narration) parts.push(scene.narration)
    scene.dialogues.forEach(function(d) {
      parts.push((d.speaker ? d.speaker + '：' : '') + d.text)
    })
    return parts.join('\n')
  }

  async function updateAvgSettingsApiStatus(el) {
    if (!el || !window.loadGameApiConfig) return
    var cfg = await window.loadGameApiConfig()
    var enabled = !!(cfg.url && cfg.key && cfg.model)
    var text = enabled ? ('已启用' + (cfg.model ? ' · ' + cfg.model : '')) : '未启用'
    el.textContent = text
    el.title = text
  }
  window.updateAvgSettingsApiStatus = updateAvgSettingsApiStatus

  function buildAvgApiCard() {
    return '' +
      '<button class="avg-game-card avg-api-card" id="game-api-card" type="button">' +
        '<div class="avg-api-card-body">' +
          '<div class="avg-api-copy">' +
            '<span class="avg-game-name">剧情API</span>' +
            '<span class="avg-api-desc">与游戏大厅共用设置，游玩消耗大量API</span>' +
            '<span class="avg-api-desc">建议使用Flash等优惠模型</span>' +
          '</div>' +
          '<span class="avg-game-last avg-api-value" id="game-api-value" data-game-api-value>读取中</span>' +
        '</div>' +
      '</button>'
  }

  // ===================================================================
  // 橙光主页（§3.1）
  // ===================================================================
  window.showAvgPage = async function() {
    var existing = document.getElementById('avg-home-page')
    if (existing) existing.remove()

    var cardsHTML = GAMES.map(function(g, i) {
      return '<button class="avg-game-card" data-game-index="' + i + '" type="button">' +
        '<img class="avg-game-cover" src="' + g.img.cover + '" alt="' + esc(g.title) + '">' +
        '<div class="avg-game-info">' +
          '<span class="avg-game-name">' + esc(g.title) + '</span>' +
          '<span class="avg-game-last" data-game-last="' + i + '">未开始</span>' +
        '</div>' +
      '</button>'
    }).join('')

    var page = document.createElement('div')
    page.id = 'avg-home-page'
    page.className = 'full-page avg-home-page'
    page.innerHTML =
      '<header class="avg-home-header">' +
        '<button class="avg-home-heading" id="avg-home-back" type="button" aria-label="返回">' +
          '<div class="avg-home-kicker">INTERACTIVE STORIES</div>' +
          '<h1>橙光</h1>' +
        '</button>' +
      '</header>' +
      '<main class="avg-home-main">' +
        cardsHTML +
        '<div class="avg-home-api-wrap">' +
          buildAvgApiCard() +
        '</div>' +
      '</main>'

    if (window.openPage) window.openPage(page)
    else (document.getElementById('app') || document.body).appendChild(page)

    page.querySelector('#avg-home-back').addEventListener('click', function() {
      window.closePage && window.closePage('avg-home-page')
    })
    page.querySelectorAll('.avg-game-card[data-game-index]').forEach(function(card) {
      card.addEventListener('click', function() {
        G = GAMES[Number(card.dataset.gameIndex)]
        showAvgTitlePage()
      })
    })
    var apiCard = page.querySelector('#game-api-card')
    if (apiCard) {
      apiCard.addEventListener('click', function() {
        window.openGameApiConfigPage && window.openGameApiConfigPage()
      })
    }

    // 各游戏卡片分别读取自己前缀下的 lastPlayedAt
    for (var i = 0; i < GAMES.length; i++) {
      var lastEl = page.querySelector('[data-game-last="' + i + '"]')
      var lastPlayed = await getAvgConfig(GAMES[i].cfgPrefix + 'lastPlayedAt', null)
      if (lastEl) lastEl.textContent = timeAgoText(lastPlayed)
    }
    if (window.updateGameApiStatus) await window.updateGameApiStatus(page)
  }

  // ===================================================================
  // 标题页（§3.2）
  // ===================================================================
  async function getGameBg() {
    var custom = await getAvgConfig(gk('customBg'), '')
    return custom || G.img.bg
  }

  async function showAvgTitlePage() {
    var existing = document.getElementById('avg-title-page')
    if (existing) existing.remove()

    var save = await loadSave()
    var bg = await getGameBg()

    var continueBtn = ''
    if (save) {
      var chapterName = G.chapters[save.chapterIndex] ? G.chapters[save.chapterIndex].name : ''
      continueBtn =
        '<button class="avg-title-btn is-primary" id="avg-btn-continue" type="button">继续游戏' +
          '<small>' + esc(chapterName) + ' · 第 ' + ((save.chapterTurns || 0) + 1) + ' 轮</small>' +
        '</button>'
    }

    var page = document.createElement('div')
    page.id = 'avg-title-page'
    page.className = 'full-page avg-title-page'
    page.innerHTML =
      '<div class="avg-title-bg" style="background-image:url(\'' + bg + '\')"></div>' +
      '<div class="avg-title-mask"></div>' +
      '<div class="avg-title-inner">' +
        '<button class="avg-title-back" id="avg-title-back" type="button"><i class="fa fa-angle-left"></i></button>' +
        '<div class="avg-title-head">' +
          '<h1>' + esc(G.title) + '</h1>' +
          '<div class="avg-title-en">' + esc(G.titleEn) + '</div>' +
        '</div>' +
        '<div class="avg-title-btns">' +
          continueBtn +
          '<button class="avg-title-btn' + (save ? '' : ' is-primary') + '" id="avg-btn-start" type="button">开始游戏</button>' +
          '<button class="avg-title-btn" id="avg-btn-settings" type="button">游戏设置</button>' +
        '</div>' +
        '<div class="avg-title-foot">' + AVG_VERSION + ' · 本游戏剧情由 AI 生成</div>' +
      '</div>'

    window.openPage ? window.openPage(page) : document.getElementById('app').appendChild(page)

    page.querySelector('#avg-title-back').addEventListener('click', function() {
      window.closePage && window.closePage('avg-title-page')
    })
    page.querySelector('#avg-btn-start').addEventListener('click', async function() {
      if (save) {
        if (!confirm('已有进行中的存档，开始新游戏将覆盖当前进度，确定吗？')) return
      }
      showAvgImportPage()
    })
    if (save) {
      page.querySelector('#avg-btn-continue').addEventListener('click', async function() {
        var current = await loadSave()
        if (!current) { toast('存档不存在'); return }
        startAvgGame(current, true)
      })
    }
    page.querySelector('#avg-btn-settings').addEventListener('click', openAvgSettings)
  }

  // ===== 游戏设置弹层（背景 / 立绘 / 横屏） =====
  async function openAvgSettings() {
    var landscape = await getAvgConfig(gk('landscape'), false)
    var spriteOn = await getAvgConfig(gk('spriteEnabled'), true)
    var hasCustomBg = !!(await getAvgConfig(gk('customBg'), ''))

    var overlay = document.createElement('div')
    overlay.className = 'avg-modal-overlay'
    overlay.innerHTML =
      '<div class="avg-modal">' +
        '<div class="avg-modal-title">游戏设置</div>' +
        '<div class="avg-set-row">' +
          '<div class="avg-set-label">游戏背景<small>' + esc(G.bgHint) + '</small></div>' +
          '<div class="avg-set-actions">' +
            (hasCustomBg ? '<button class="avg-mini-btn" id="avg-bg-reset" type="button">恢复默认</button>' : '') +
            '<button class="avg-mini-btn" id="avg-bg-upload" type="button">上传</button>' +
          '</div>' +
        '</div>' +
        '<div class="avg-set-row">' +
          '<div class="avg-set-label">显示立绘<small>角色说话时展示立绘</small></div>' +
          '<label class="avg-switch"><input type="checkbox" id="avg-sw-sprite"' + (spriteOn ? ' checked' : '') + '><i></i></label>' +
        '</div>' +
        '<div class="avg-set-row">' +
          '<div class="avg-set-label">横屏模式<small>旋转画面「伪横屏模式」，推荐体验；随时可在游戏内切换</small></div>' +
          '<label class="avg-switch"><input type="checkbox" id="avg-sw-landscape"' + (landscape ? ' checked' : '') + '><i></i></label>' +
        '</div>' +
        '<div class="avg-set-row">' +
          '<div class="avg-set-label">剧情 API<small>橙光页面剧情API，未启用时自动使用主 API</small></div>' +
          '<div class="avg-set-status" data-avg-api-status>读取中</div>' +
        '</div>' +
      '</div>'

    document.getElementById('app').appendChild(overlay)
    requestAnimationFrame(function() { overlay.classList.add('show') })
    var close = function() {
      overlay.classList.remove('show')
      setTimeout(function() { overlay.remove() }, 200)
    }
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close() })
    await updateAvgSettingsApiStatus(overlay.querySelector('[data-avg-api-status]'))

    overlay.querySelector('#avg-bg-upload').addEventListener('click', function() {
      if (!window.showImagePicker) return
      window.showImagePicker(async function(dataUrl) {
        await setAvgConfig(gk('customBg'), dataUrl)
        toast('背景已更新')
        close()
      })
    })
    var resetBtn = overlay.querySelector('#avg-bg-reset')
    if (resetBtn) resetBtn.addEventListener('click', async function() {
      await setAvgConfig(gk('customBg'), '')
      toast('已恢复默认背景')
      close()
    })
    overlay.querySelector('#avg-sw-sprite').addEventListener('change', function() {
      setAvgConfig(gk('spriteEnabled'), this.checked)
    })
    overlay.querySelector('#avg-sw-landscape').addEventListener('change', function() {
      setAvgConfig(gk('landscape'), this.checked)
    })
  }

  // ===================================================================
  // 角色导入页（§3.3）
  // ===================================================================
  async function showAvgImportPage() {
    var existing = document.getElementById('avg-import-page')
    if (existing) existing.remove()

    var allChars = await db.characters.toArray()
    var customRoles = (await getAvgConfig(CUSTOM_ROLES_KEY, [])) || []
    var dbChars = allChars.filter(function(c) { return c && c.type !== 'user' && c.name })
    var userChar = allChars.filter(function(c) { return c && c.type === 'user' })[0] || null
    var groups = []
    dbChars.forEach(function(c) {
      var g = (c.group || '').trim()
      if (g && groups.indexOf(g) < 0) groups.push(g)
    })

    // 统一候选模型：key -> entry（preset / custom / db 三来源）
    var entries = {}
    function addEntry(e) { entries[e.key] = e; return e }
    G.presetRoles.forEach(function(p) {
      addEntry({ key: 'preset:' + p.presetId, source: 'preset', name: p.name, gender: p.gender, persona: p.persona, tags: p.tags, avatar: p.avatar, defaultRelation: p.relation, desc: p.tags.join(' · ') })
    })
    customRoles.forEach(function(r) {
      addEntry({ key: 'custom:' + r.id, source: 'custom', customId: r.id, name: r.name, gender: r.gender || '', persona: r.persona, tags: [], avatar: '', desc: String(r.persona || '').replace(/\s+/g, ' ').slice(0, 40) })
    })
    dbChars.forEach(function(c) {
      addEntry({ key: 'db:' + c.id, source: 'db', name: c.name, gender: c.gender || '', persona: String(c.description || ''), tags: [], avatar: c.avatar || '', group: (c.group || '').trim(), desc: String(c.description || '').replace(/\s+/g, ' ').slice(0, 40) || '暂无人设' })
    })

    var selected = {}   // key -> relationIndex
    var playerGender = '女'
    var playerAvatar = (userChar && userChar.avatar) || ''

    function roleItemHTML(e) {
      var delBtn = e.source === 'custom'
        ? '<button class="avg-char-del" type="button" title="删除"><i class="fa fa-xmark"></i></button>'
        : ''
      return '<div class="avg-char-item" data-key="' + esc(e.key) + '" data-group="' + esc(e.group || '') + '">' +
        '<div class="avg-char-avatar">' + avatarHTML(e.name, e.avatar) + '</div>' +
        '<div class="avg-char-info">' +
          '<div class="avg-char-name">' + esc(e.name) + (e.gender ? ' <small style="font-weight:400;color:var(--c-hint)">' + esc(e.gender) + '</small>' : '') + '</div>' +
          '<div class="avg-char-desc">' + esc(e.desc || '') + '</div>' +
        '</div>' +
        delBtn +
        '<button class="avg-seat-chip" type="button" style="display:none">' + esc(G.relations[0]) + '</button>' +
        '<div class="avg-check"><i class="fa fa-check"></i></div>' +
      '</div>'
    }

    var page = document.createElement('div')
    page.id = 'avg-import-page'
    page.className = 'full-page avg-import-page'

    var groupChips = ''
    if (groups.length) {
      groupChips = '<div class="avg-group-chips">' +
        '<button class="avg-group-chip active" data-group="" type="button">全部</button>' +
        groups.map(function(g) {
          return '<button class="avg-group-chip" data-group="' + esc(g) + '" type="button">' + esc(g) + '</button>'
        }).join('') +
      '</div>'
    }

    var presetHTML = G.presetRoles.map(function(p) { return roleItemHTML(entries['preset:' + p.presetId]) }).join('')
    var customHTML = customRoles.map(function(r) { return roleItemHTML(entries['custom:' + r.id]) }).join('')
    var dbHTML = dbChars.length
      ? dbChars.map(function(c) { return roleItemHTML(entries['db:' + c.id]) }).join('')
      : '<div class="avg-import-empty">角色档案是空的<br>可以直接使用内置角色或自建角色</div>'

    page.innerHTML =
      '<header class="avg-sub-header">' +
        '<button class="avg-sub-back" id="avg-import-back" type="button"><i class="fa fa-angle-left"></i></button>' +
        '<span class="avg-sub-title">' + esc(G.importTitle) + '</span>' +
        '<span class="avg-sub-sub" id="avg-import-count">已选 0 / 5</span>' +
      '</header>' +
      '<div class="avg-import-scroll">' +
        '<div class="avg-section-title">主角设置</div>' +
        '<div class="avg-player-card">' +
          '<button class="avg-player-avatar" id="avg-player-avatar" type="button">' +
            (playerAvatar ? '<img src="' + esc(playerAvatar) + '" alt="">' : '<i class="fa fa-user-plus"></i>') +
          '</button>' +
          '<div class="avg-player-fields">' +
            '<input id="avg-player-name" maxlength="12" placeholder="主角名字" value="' + esc((userChar && (userChar.nick || userChar.name)) || '') + '">' +
            '<div class="avg-gender-tabs">' +
              ['女', '男', '其他'].map(function(g) {
                return '<button class="avg-gender-tab' + (g === '女' ? ' active' : '') + '" data-gender="' + g + '" type="button">' + g + '</button>'
              }).join('') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="avg-section-title">' + esc(G.importHint) + '</div>' +
        '<div class="avg-section-title">内置角色</div>' +
        '<div class="avg-char-list">' + presetHTML + '</div>' +
        '<div class="avg-section-title">我的自建</div>' +
        '<div class="avg-char-list" id="avg-custom-list">' + customHTML +
          '<button class="avg-add-role-btn" id="avg-add-role" type="button"><i class="fa fa-plus"></i>　自建角色</button>' +
        '</div>' +
        '<div class="avg-section-title">角色档案</div>' +
        groupChips +
        '<div class="avg-char-list">' + dbHTML + '</div>' +
      '</div>' +
      '<div class="avg-import-foot">' +
        '<button class="avg-primary-btn" id="avg-import-next" type="button" disabled>点击确认角色</button>' +
      '</div>'

    window.openPage ? window.openPage(page) : document.getElementById('app').appendChild(page)

    page.querySelector('#avg-import-back').addEventListener('click', function() {
      window.closePage && window.closePage('avg-import-page')
    })

    // 性别 tabs
    page.querySelectorAll('.avg-gender-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        page.querySelectorAll('.avg-gender-tab').forEach(function(t) { t.classList.remove('active') })
        tab.classList.add('active')
        playerGender = tab.dataset.gender
      })
    })

    // 头像上传
    page.querySelector('#avg-player-avatar').addEventListener('click', function() {
      if (!window.showImagePicker) return
      window.showImagePicker(function(dataUrl) {
        playerAvatar = dataUrl
        page.querySelector('#avg-player-avatar').innerHTML = '<img src="' + esc(dataUrl) + '" alt="">'
      })
    })

    // 角色档案分组筛选（仅作用于 db 来源的条目）
    page.querySelectorAll('.avg-group-chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        page.querySelectorAll('.avg-group-chip').forEach(function(c) { c.classList.remove('active') })
        chip.classList.add('active')
        var g = chip.dataset.group
        page.querySelectorAll('.avg-char-item[data-key^="db:"]').forEach(function(item) {
          item.style.display = (!g || item.dataset.group === g) ? '' : 'none'
        })
      })
    })

    function updateCount() {
      var n = Object.keys(selected).length
      page.querySelector('#avg-import-count').textContent = '已选 ' + n + ' / 5'
      page.querySelector('#avg-import-next').disabled = n < 3 || n > 5
    }

    // 选择 + 关系位 chip 轮换 + 自建删除
    function bindRoleItem(item) {
      var key = item.dataset.key
      var seatChip = item.querySelector('.avg-seat-chip')
      seatChip.addEventListener('click', function(e) {
        e.stopPropagation()
        if (selected[key] == null) return
        selected[key] = (selected[key] + 1) % G.relations.length
        seatChip.textContent = G.relations[selected[key]]
      })
      var delBtn = item.querySelector('.avg-char-del')
      if (delBtn) delBtn.addEventListener('click', async function(e) {
        e.stopPropagation()
        var entry = entries[key]
        if (!confirm('删除自建角色「' + entry.name + '」？')) return
        customRoles = customRoles.filter(function(r) { return String(r.id) !== String(entry.customId) })
        await setAvgConfig(CUSTOM_ROLES_KEY, customRoles)
        delete selected[key]
        delete entries[key]
        item.remove()
        updateCount()
      })
      item.addEventListener('click', function() {
        if (selected[key] != null) {
          delete selected[key]
          item.classList.remove('selected')
          seatChip.style.display = 'none'
        } else {
          if (Object.keys(selected).length >= 5) { toast('最多选择 5 名角色'); return }
          // 内置角色带推荐关系位，其余按已选数量轮转
          var entry = entries[key]
          selected[key] = (entry && entry.defaultRelation != null)
            ? entry.defaultRelation
            : Object.keys(selected).length % G.relations.length
          item.classList.add('selected')
          seatChip.textContent = G.relations[selected[key]]
          seatChip.style.display = ''
        }
        updateCount()
      })
    }
    page.querySelectorAll('.avg-char-item').forEach(bindRoleItem)

    // 自建角色弹层
    page.querySelector('#avg-add-role').addEventListener('click', function() {
      openCustomRoleForm(async function(role) {
        customRoles.push(role)
        await setAvgConfig(CUSTOM_ROLES_KEY, customRoles)
        var entry = addEntry({ key: 'custom:' + role.id, source: 'custom', customId: role.id, name: role.name, gender: role.gender || '', persona: role.persona, tags: [], avatar: '', desc: String(role.persona || '').replace(/\s+/g, ' ').slice(0, 40) })
        var addBtn = page.querySelector('#avg-add-role')
        addBtn.insertAdjacentHTML('beforebegin', roleItemHTML(entry))
        bindRoleItem(addBtn.previousElementSibling)
      })
    })

    page.querySelector('#avg-import-next').addEventListener('click', function() {
      var name = page.querySelector('#avg-player-name').value.trim()
      if (!name) { toast('请填写主角名字'); return }
      var picks = Object.keys(selected).map(function(key) {
        var e = entries[key]
        return {
          name: e.name,
          gender: e.gender || '',
          origGender: e.gender || '',
          origPersona: e.persona || '',
          persona: e.source === 'preset' ? e.persona : '',
          tags: e.source === 'preset' ? e.tags.slice() : [],
          preset: e.source === 'preset',
          seat: G.relations[selected[key]],
          avatar: e.avatar || '',
          sprite: '',
          favor: 0
        }
      })
      showAvgAdaptPage({
        player: { name: name, gender: playerGender, avatar: playerAvatar },
        characters: picks
      })
    })
  }

  // ===== 自建角色表单弹层 =====
  function openCustomRoleForm(onSave) {
    var overlay = document.createElement('div')
    overlay.className = 'avg-modal-overlay'
    overlay.innerHTML =
      '<div class="avg-modal avg-role-form">' +
        '<div class="avg-modal-title">自建角色</div>' +
        '<input id="avg-role-name" maxlength="12" placeholder="角色名字（必填）">' +
        '<div class="avg-gender-tabs">' +
          ['男', '女', '其他'].map(function(g, i) {
            return '<button class="avg-gender-tab' + (i === 0 ? ' active' : '') + '" data-gender="' + g + '" type="button">' + g + '</button>'
          }).join('') +
        '</div>' +
        '<textarea id="avg-role-persona" placeholder="人设（必填）：身份、性格、说话方式、雷点与喜好……任意世界观均可，进入游戏前会自动做人设调整"></textarea>' +
        '<button class="avg-primary-btn" id="avg-role-save" type="button">保存角色</button>' +
      '</div>'
    document.getElementById('app').appendChild(overlay)
    requestAnimationFrame(function() { overlay.classList.add('show') })
    var close = function() {
      overlay.classList.remove('show')
      setTimeout(function() { overlay.remove() }, 200)
    }
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close() })

    var gender = '男'
    overlay.querySelectorAll('.avg-gender-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        overlay.querySelectorAll('.avg-gender-tab').forEach(function(t) { t.classList.remove('active') })
        tab.classList.add('active')
        gender = tab.dataset.gender
      })
    })
    overlay.querySelector('#avg-role-save').addEventListener('click', function() {
      var name = overlay.querySelector('#avg-role-name').value.trim()
      var persona = overlay.querySelector('#avg-role-persona').value.trim()
      if (!name) { toast('请填写角色名字'); return }
      if (!persona) { toast('请填写人设'); return }
      close()
      onSave({ id: Date.now(), name: name, gender: gender, persona: persona })
    })
  }

  // ===================================================================
  // 角色改编页（§5.0，改编 Prompt 来自当前游戏定义）
  // ===================================================================
  async function adaptOneCharacter(ch) {
    var raw = await window.callGameAI(
      [{ role: 'user', content: G.buildAdaptPrompt({ name: ch.name, gender: ch.origGender, persona: ch.origPersona, seat: ch.seat }) }],
      { responseFormat: 'json_object', temperature: 0.7 }
    )
    var text = String(raw || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    var start = text.indexOf('{')
    var end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('返回内容不是有效 JSON')
    var obj = JSON.parse(text.slice(start, end + 1))
    if (!obj || !obj.persona) throw new Error('改编结果缺少人设')
    // 原档案有性别时强制覆盖回原性别，防止模型越权修改
    var gender = ch.origGender || String(obj.gender || '').trim() || '未知'
    return { gender: gender, persona: String(obj.persona).trim(), tags: normalizeTags(obj.tags) }
  }

  function showAvgAdaptPage(setup) {
    var existing = document.getElementById('avg-adapt-page')
    if (existing) existing.remove()

    var page = document.createElement('div')
    page.id = 'avg-adapt-page'
    page.className = 'full-page avg-adapt-page'

    var cards = setup.characters.map(function(c, i) {
      return '<div class="avg-adapt-card" data-index="' + i + '">' +
        '<div class="avg-adapt-head">' +
          '<button class="avg-adapt-avatar" data-role="avatar" type="button">' + avatarHTML(c.name, c.avatar) + '</button>' +
          '<span class="avg-adapt-name">' + esc(c.name) + '</span>' +
          '<span class="avg-adapt-meta" data-role="gender">' + esc(c.gender || '待判定') + ' · ' + esc(c.seat) + '</span>' +
          '<span class="avg-adapt-status" data-role="status">' + (c.preset ? '内置角色' : '等待') + '</span>' +
        '</div>' +
        '<div data-role="tags">' + tagsHTML(c.tags) + '</div>' +
        '<textarea class="avg-adapt-persona" data-role="persona" placeholder="人设生成中…"' + (c.preset ? '' : ' disabled') + '>' + (c.preset ? esc(c.persona) : '') + '</textarea>' +
        '<div class="avg-adapt-sprite">' +
          '<div class="avg-adapt-sprite-thumb" data-role="sprite-thumb"><span>无立绘</span></div>' +
          '<div class="avg-adapt-sprite-info">' +
            '<div class="avg-adapt-sprite-label">专属立绘</div>' +
            '<div class="avg-adapt-sprite-hint">建议竖版、透明背景 PNG；未上传时游戏内使用默认立绘</div>' +
          '</div>' +
          '<button class="avg-mini-btn" data-role="sprite-clear" type="button" style="display:none">移除</button>' +
          '<button class="avg-mini-btn" data-role="sprite-upload" type="button">上传</button>' +
        '</div>' +
        '<div class="avg-adapt-actions"' + (c.preset ? ' style="display:none"' : '') + '>' +
          '<button class="avg-mini-btn" data-role="regen" type="button" disabled>重新生成</button>' +
        '</div>' +
      '</div>'
    }).join('')

    page.innerHTML =
      '<header class="avg-sub-header">' +
        '<button class="avg-sub-back" id="avg-adapt-back" type="button"><i class="fa fa-angle-left"></i></button>' +
        '<span class="avg-sub-title">角色人设调整</span>' +
      '</header>' +
      '<div class="avg-adapt-scroll">' +
        '<div class="avg-adapt-tip">' + esc(G.adaptTip) + '</div>' +
        cards +
      '</div>' +
      '<div class="avg-import-foot">' +
        '<button class="avg-primary-btn" id="avg-adapt-start" type="button" disabled>开始游戏</button>' +
      '</div>'

    window.openPage ? window.openPage(page) : document.getElementById('app').appendChild(page)

    page.querySelector('#avg-adapt-back').addEventListener('click', function() {
      window.closePage && window.closePage('avg-adapt-page')
    })

    var doneFlags = setup.characters.map(function(c) { return !!c.preset })

    function cardEls(i) {
      var card = page.querySelector('.avg-adapt-card[data-index="' + i + '"]')
      return {
        card: card,
        avatar: card.querySelector('[data-role="avatar"]'),
        status: card.querySelector('[data-role="status"]'),
        gender: card.querySelector('[data-role="gender"]'),
        tags: card.querySelector('[data-role="tags"]'),
        persona: card.querySelector('[data-role="persona"]'),
        regen: card.querySelector('[data-role="regen"]'),
        spriteThumb: card.querySelector('[data-role="sprite-thumb"]'),
        spriteUpload: card.querySelector('[data-role="sprite-upload"]'),
        spriteClear: card.querySelector('[data-role="sprite-clear"]')
      }
    }

    function refreshStartBtn() {
      var allDone = doneFlags.every(Boolean)
      page.querySelector('#avg-adapt-start').disabled = !allDone
    }

    async function runAdapt(i) {
      var ch = setup.characters[i]
      var els = cardEls(i)
      doneFlags[i] = false
      refreshStartBtn()
      els.status.classList.remove('is-error')
      els.status.textContent = '正在生成…'
      els.regen.disabled = true
      els.persona.disabled = true
      try {
        var result = await adaptOneCharacter(ch)
        ch.gender = result.gender
        ch.persona = result.persona
        ch.tags = result.tags
        els.gender.textContent = ch.gender + ' · ' + ch.seat
        els.tags.innerHTML = tagsHTML(ch.tags)
        els.persona.value = ch.persona
        els.persona.disabled = false
        els.status.textContent = '完成'
        doneFlags[i] = true
      } catch (err) {
        els.status.classList.add('is-error')
        els.status.textContent = '失败，建议重试'
        els.persona.value = ''
        els.persona.placeholder = '改编失败：' + (err.message || err)
      } finally {
        els.regen.disabled = false
        refreshStartBtn()
      }
    }

    setup.characters.forEach(function(ch, i) {
      var els = cardEls(i)
      if (els.regen) els.regen.addEventListener('click', function() { runAdapt(i) })
      els.avatar.addEventListener('click', function() {
        if (!window.showImagePicker) return
        window.showImagePicker(function(dataUrl) {
          ch.avatar = dataUrl
          els.avatar.innerHTML = avatarHTML(ch.name, dataUrl)
        })
      })
      function renderSprite() {
        els.spriteThumb.innerHTML = ch.sprite
          ? '<img src="' + esc(ch.sprite) + '" alt="" onerror="this.remove()">'
          : '<span>无立绘</span>'
        els.spriteClear.style.display = ch.sprite ? '' : 'none'
      }
      els.spriteUpload.addEventListener('click', function() {
        if (!window.showImagePicker) return
        window.showImagePicker(async function(dataUrl) {
          var result = await compressSpriteImage(dataUrl)
          if (!result) { toast('立绘图片无法读取'); return }
          ch.sprite = result
          renderSprite()
        })
      })
      els.spriteClear.addEventListener('click', function() {
        ch.sprite = ''
        renderSprite()
      })
      renderSprite()
      els.persona.addEventListener('input', function() {
        ch.persona = els.persona.value.trim()
        doneFlags[i] = !!ch.persona
        refreshStartBtn()
      })
    })
    refreshStartBtn()

    // 逐个串行调用（内置角色跳过），避免并发打爆接口
    ;(async function() {
      for (var i = 0; i < setup.characters.length; i++) {
        if (setup.characters[i].preset) continue
        await runAdapt(i)
      }
    })()

    page.querySelector('#avg-adapt-start').addEventListener('click', async function() {
      // 收集最终微调结果
      var invalid = setup.characters.some(function(c, i) {
        var els = cardEls(i)
        c.persona = els.persona.value.trim()
        return !c.persona
      })
      if (invalid) { toast('等待角色档案生成'); return }

      await deleteSave()
      // 立绘单独落 avgConfigs（开局写一次），避免随每轮存档重写 base64 大字符串
      var spriteMap = {}
      setup.characters.forEach(function(c) {
        if (c.sprite) spriteMap[c.name] = c.sprite
      })
      await setAvgConfig(gk('charSprites'), spriteMap)
      var initialStats = {}
      G.statKeys.forEach(function(k) { initialStats[k] = G.initialStats[k] })
      var save = {
        gameId: G.id,
        slot: SAVE_SLOT,
        player: setup.player,
        characters: setup.characters.map(function(c) {
          return { name: c.name, gender: c.gender, persona: c.persona, tags: c.tags || [], seat: c.seat, avatar: c.avatar, favor: 0, logs: [], chapterStartFavor: 0 }
        }),
        stats: initialStats,
        drama: 0,
        chapterIndex: 0,
        chapterTurns: 0,
        metCharacters: [],
        pendingChapterEnd: false,
        history: [],
        lastScene: null,
        unlockedEvents: [],
        chapterSummaries: [],
        storyLog: [],
        suspicion: {},   // 各角色疑心快照（《谍影留声》增量，纯展示）
        tokens: '',      // 第四章信物轮选择（《谍影留声》增量，终章注入）
        updatedAt: Date.now()
      }
      await writeSave(save)
      window.closePage && window.closePage('avg-adapt-page')
      window.closePage && window.closePage('avg-import-page')
      startAvgGame(save, false)
    })
  }

  // ===================================================================
  // 背景音乐（会话级，不持久化；每局默认开启播放本作默认曲）
  // ===================================================================
  var _bgm = { audio: null, on: true, id: '', name: '默认音乐', token: 0 }

  // 把网易云歌曲 id 解析成稳定直链：meting 的 type=url 只是 302 端点，每次续拉都换签名
  // 导致 <audio> range 请求错位（约 30 秒即断）；gdstudio types=url 直接返回已解析的直链，
  // 支持正常 range 请求可放全曲。moeyao 端点仅作兜底。
  function resolveBgmUrl(id) {
    var gd = 'https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=' + encodeURIComponent(id)
    return fetch(gd)
      .then(function(res) { return res.json() })
      .then(function(data) {
        if (data && data.url) return data.url
        throw new Error('no url')
      })
      .catch(function() {
        return 'https://api.moeyao.cn/meting/?server=netease&type=url&id=' + encodeURIComponent(id)
      })
  }

  function playBgm(id, name) {
    if (!id) return
    _bgm.id = id
    if (name) _bgm.name = name
    // BGM 自身可保活，播放期间挂起额外的 Web Audio 会话
    window._avgBgmActive = true
    if (window.WanWanKeepAlive) window.WanWanKeepAlive.suspendForMedia()
    if (!_bgm.audio) {
      _bgm.audio = new Audio()
      _bgm.audio.loop = true
    }
    var token = ++_bgm.token   // 快速切歌时丢弃过期解析结果
    resolveBgmUrl(id).then(function(url) {
      if (token !== _bgm.token || !_bgm.on || !_bgm.audio) return
      _bgm.audio.src = url
      _bgm.audio.play().catch(function() {
        // iOS 自动播放被拒时，借下一次点击手势重试
        document.addEventListener('click', function retry() {
          document.removeEventListener('click', retry)
          if (_bgm.on && _bgm.audio && _bgm.audio.paused) _bgm.audio.play().catch(function() {})
        })
      })
    })
  }

  async function stopBgm() {
    if (_bgm.audio) {
      _bgm.audio.pause()
      _bgm.audio.removeAttribute('src')
      _bgm.audio.load()
      _bgm.audio = null
    }
    window._avgBgmActive = false
    if (window.WanWanKeepAlive) window.WanWanKeepAlive.resumeAfterMedia()
  }

  // 回前台后系统可能已暂停 BGM，恢复播放
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible') return
    if (_game && _bgm.on && _bgm.audio && _bgm.audio.paused) _bgm.audio.play().catch(function() {})
  })

  // ===================================================================
  // 游戏主界面（§3.4 / §3.5）
  // ===================================================================
  var _game = null  // 当前对局运行时状态

  async function startAvgGame(save, isResume) {
    var existing = document.getElementById('avg-game-page')
    if (existing) existing.remove()

    var bg = await getGameBg()
    var spriteEnabled = await getAvgConfig(gk('spriteEnabled'), true)
    var landscape = await getAvgConfig(gk('landscape'), false)
    var charSprites = (await getAvgConfig(gk('charSprites'), {})) || {}

    var page = document.createElement('div')
    page.id = 'avg-game-page'
    page.className = 'full-page avg-game-page' + (landscape ? ' avg-landscape' : '')
    page.innerHTML =
      '<div class="avg-rotor">' +
        '<div class="avg-bg" style="background-image:url(\'' + bg + '\')"></div>' +
        '<div class="avg-bg-mask"></div>' +
        '<div class="avg-sprite" id="avg-sprite"><img alt=""></div>' +
        '<div class="avg-topbar">' +
          '<div class="avg-chapter-tag" id="avg-chapter-tag"></div>' +
          '<div class="avg-topbtns">' +
            '<button class="avg-top-btn" id="avg-btn-panel" type="button" title="攻略面板"><i class="fa fa-heart"></i></button>' +
            '<button class="avg-top-btn" id="avg-btn-rotate" type="button" title="横屏切换"><i class="fa fa-rotate"></i></button>' +
            '<button class="avg-top-btn" id="avg-btn-settings" type="button" title="游戏设置"><i class="fa fa-gear"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="avg-dialog-wrap">' +
          '<div class="avg-nametag is-hidden" id="avg-nametag"></div>' +
          '<div class="avg-dialog" id="avg-dialog">' +
            '<div class="avg-dialog-text" id="avg-dialog-text"></div>' +
            '<div class="avg-next-hint" id="avg-next-hint" style="display:none"><i class="fa fa-caret-down"></i></div>' +
          '</div>' +
        '</div>' +
        '<div class="avg-choices" id="avg-choices" style="display:none"></div>' +
        '<div class="avg-panel-overlay" id="avg-panel-overlay" style="display:none"></div>' +
        '<div class="avg-panel" id="avg-panel"></div>' +
      '</div>'

    window.openPage ? window.openPage(page) : document.getElementById('app').appendChild(page)

    _game = {
      save: save,
      page: page,
      spriteEnabled: spriteEnabled,
      sprites: charSprites,   // 角色名 -> 立绘图（perCharSprite 存档专用）
      queue: [],        // 待播放的对话步骤
      queueIndex: 0,
      typing: null,     // 打字机计时器
      busy: false,      // 请求中
      pendingAction: null,
      endEventPlaying: false,
      awaitingEndEventChoice: false   // 信物轮：章末事件带选项时等待玩家表态
    }

    updateChapterTag()

    // 顶栏按钮
    page.querySelector('#avg-btn-panel').addEventListener('click', openStrategyPanel)
    page.querySelector('#avg-btn-rotate').addEventListener('click', async function() {
      var on = !page.classList.contains('avg-landscape')
      page.classList.toggle('avg-landscape', on)
      await setAvgConfig(gk('landscape'), on)
    })
    page.querySelector('#avg-btn-settings').addEventListener('click', openSettingsPanel)

    // 对话框推进
    page.querySelector('#avg-dialog').addEventListener('click', advanceDialog)

    // 首次进入提示横屏
    var hintShown = await getAvgConfig(gk('landscapeHintShown'), false)
    if (!hintShown && !landscape) {
      await setAvgConfig(gk('landscapeHintShown'), true)
      showLandscapeHint(page)
    }

    // 每局默认开启音乐，播放本作默认曲（本函数由用户点击触发，满足自动播放手势要求）
    _bgm.on = true
    playBgm(G.bgmId, '默认音乐')

    if (isResume && save.lastScene) {
      playScene(save.lastScene, { resume: true })
    } else {
      requestTurn(G.openingAction(save))
    }
  }

  function showLandscapeHint(page) {
    var overlay = document.createElement('div')
    overlay.className = 'avg-settle-overlay'
    overlay.innerHTML =
      '<div class="avg-hint-card">' +
        '<h3>横屏体验更佳</h3>' +
        '<p>本作推荐横屏游玩，点击顶栏 <i class="fa fa-rotate"></i> 可随时切换横竖屏。<br>竖屏下同样可以正常游玩。</p>' +
        '<button class="avg-primary-btn" type="button">知道了</button>' +
      '</div>'
    page.querySelector('.avg-rotor').appendChild(overlay)
    requestAnimationFrame(function() { overlay.classList.add('show') })
    overlay.querySelector('button').addEventListener('click', function() {
      overlay.classList.remove('show')
      setTimeout(function() { overlay.remove() }, 300)
    })
  }

  function updateChapterTag() {
    if (!_game) return
    var save = _game.save
    var chapter = G.chapters[save.chapterIndex]
    var tag = _game.page.querySelector('#avg-chapter-tag')
    if (tag) tag.innerHTML = esc(chapter.name) + '<small>第 ' + (save.chapterTurns + 1) + ' 轮</small>'
  }

  // ===== 剧情请求 =====
  async function requestTurn(userAction) {
    if (!_game || _game.busy) return
    var save = _game.save
    _game.busy = true
    _game.pendingAction = userAction
    hideChoices()
    setDialogLoading()

    var messages = save.history.slice(-HISTORY_LIMIT).concat([{ role: 'user', content: userAction }])
    try {
      for (var attempt = 0; attempt <= AUTO_RETRY_MAX; attempt++) {
        if (attempt > 0) {
          setDialogLoading('剧情生成中（自动重试 ' + attempt + '/' + AUTO_RETRY_MAX + '）')
          await new Promise(function(r) { setTimeout(r, 1000) })
          if (!_game) return
        }
        var raw = await window.callGameAI(messages, {
          system: buildSystemPrompt(save),
          responseFormat: 'json_object',
          temperature: 0.85
        })
        if (!_game) return
        var isEmpty = !String(raw || '').trim()
        var scene = isEmpty ? null : parseSceneJSON(raw)
        if (scene) {
          onSceneReceived(scene, userAction)
          return
        }
        if (attempt === AUTO_RETRY_MAX) {
          // 自动重试用尽：空回给提示，格式失败降级展示原始输出（§5.2）
          if (isEmpty) showRequestError('AI 返回了空内容，可能是服务波动或上下文过长')
          else showPlainFallback(String(raw).slice(0, 600))
        }
      }
    } catch (err) {
      if (!_game) return
      showRequestError(err.message || String(err))
    } finally {
      if (_game) _game.busy = false
    }
  }

  async function onSceneReceived(scene, userAction) {
    var save = _game.save
    var wasEndEvent = save.pendingChapterEnd

    // 记录历史
    save.history.push({ role: 'user', content: userAction })
    save.history.push({ role: 'assistant', content: compactScene(scene) })
    if (save.history.length > HISTORY_LIMIT * 2) {
      save.history = save.history.slice(-HISTORY_LIMIT * 2)
    }

    // 剧情全文持久化（回顾剧情面板用）
    save.storyLog = save.storyLog || []
    save.storyLog.push({
      chapter: G.chapters[save.chapterIndex].name,
      action: userAction,
      text: fullSceneText(scene)
    })

    // 出场角色记录（序章章末条件）
    scene.dialogues.forEach(function(d) {
      save.characters.forEach(function(c) {
        if (d.speaker && d.speaker.indexOf(c.name) >= 0 && save.metCharacters.indexOf(c.name) < 0) {
          save.metCharacters.push(c.name)
        }
      })
    })

    // 疑心快照（《谍影留声》增量：纯展示，不参与结算）
    if (G.hasSuspicion && scene.suspicion) save.suspicion = scene.suspicion

    save.chapterTurns++
    save.lastScene = scene
    _game.endEventPlaying = wasEndEvent
    if (wasEndEvent) save.pendingChapterEnd = false

    updateChapterTag()
    await writeSave(save)
    playScene(scene, {})
  }

  // ===== 场景播放（打字机队列） =====
  function playScene(scene, opts) {
    if (!_game) return
    _game.currentScene = scene
    _game.queue = []
    if (scene.narration) _game.queue.push({ speaker: '', text: scene.narration })
    scene.dialogues.forEach(function(d) {
      _game.queue.push({ speaker: d.speaker, text: d.text })
    })
    if (!_game.queue.length) _game.queue.push({ speaker: '', text: '……' })
    _game.queueIndex = 0
    hideChoices()
    showStep(_game.queue[0])
  }

  function showStep(step) {
    if (!_game) return
    var page = _game.page
    var nametag = page.querySelector('#avg-nametag')
    var textEl = page.querySelector('#avg-dialog-text')
    var hint = page.querySelector('#avg-next-hint')
    var sprite = page.querySelector('#avg-sprite')

    var isNarration = !step.speaker
    nametag.textContent = isNarration ? '' : step.speaker
    nametag.classList.toggle('is-hidden', isNarration)

    // 立绘：按说话人显示专属立绘，未上传的角色回退默认立绘
    var speakChar = null
    if (!isNarration) {
      _game.save.characters.some(function(c) {
        if (step.speaker.indexOf(c.name) >= 0) { speakChar = c; return true }
        return false
      })
    }
    var spriteSrc = speakChar ? (_game.sprites[speakChar.name] || G.img.sprite) : ''
    var spriteImg = sprite.querySelector('img')
    if (spriteSrc && spriteImg.getAttribute('src') !== spriteSrc) spriteImg.src = spriteSrc
    sprite.classList.toggle('show', _game.spriteEnabled && !!spriteSrc)

    hint.style.display = 'none'
    // 打字机
    if (_game.typing) { clearInterval(_game.typing); _game.typing = null }
    var chars = Array.from(step.text)
    var i = 0
    textEl.textContent = ''
    _game.typing = setInterval(function() {
      if (!_game) { return }
      i += 2
      textEl.textContent = chars.slice(0, i).join('')
      if (i >= chars.length) {
        clearInterval(_game.typing)
        _game.typing = null
        textEl.textContent = step.text
        hint.style.display = ''
      }
    }, 34)
  }

  function advanceDialog() {
    if (!_game || _game.busy) return
    var page = _game.page
    var textEl = page.querySelector('#avg-dialog-text')
    var step = _game.queue[_game.queueIndex]
    if (!step) return

    // 打字中 → 立即补全
    if (_game.typing) {
      clearInterval(_game.typing)
      _game.typing = null
      textEl.textContent = step.text
      page.querySelector('#avg-next-hint').style.display = ''
      return
    }

    // 播放下一步
    if (_game.queueIndex < _game.queue.length - 1) {
      _game.queueIndex++
      showStep(_game.queue[_game.queueIndex])
      return
    }

    // 队列播完
    onSceneFinished()
  }

  async function onSceneFinished() {
    if (!_game) return
    var save = _game.save
    var scene = _game.currentScene

    // 章末事件播完 → 结算并进入下一章 / 结局
    if (_game.endEventPlaying) {
      _game.endEventPlaying = false
      var chapter = G.chapters[save.chapterIndex]
      // 信物轮：章末事件要求玩家表态，先展示选项，选择后再收束本章
      if (chapter.endEventChoice && scene && scene.choices && scene.choices.length) {
        _game.awaitingEndEventChoice = true
        showChoices(scene.choices)
        return
      }
      await finishChapterEnd(scene)
      return
    }

    // 常规轮：展示选项；无选项时给一个「继续」
    var choices = (scene && scene.choices) || []
    if (choices.length) {
      showChoices(choices)
    } else {
      showChoices([{ text: '继续', effects: {} }])
    }
  }

  // 章末事件收束：解锁事件 + 互动记录 + 章节摘要 → 结算页 / 结局页
  async function finishChapterEnd(scene) {
    var save = _game.save
    var chapter = G.chapters[save.chapterIndex]
    save.unlockedEvents.push({
      chapter: chapter.name,
      note: (scene && (scene.narration || (scene.dialogues[0] && scene.dialogues[0].text)) || '').slice(0, 42)
    })
    recordChapterLogs(save, scene)
    recordChapterSummary(save, scene)
    if (save.chapterIndex >= G.chapters.length - 1) {
      await showEnding(scene)
    } else {
      await showChapterSettle()
    }
  }

  // ===== 互动记录（每章结束时为每个角色记一条，模型漏给时按好感变化兜底） =====
  function recordChapterLogs(save, scene) {
    var chapterName = G.chapters[save.chapterIndex].name
    save.characters.forEach(function(c) {
      var text = scene && scene.chapterLog && scene.chapterLog[c.name]
      if (!text) {
        var delta = (c.favor || 0) - (c.chapterStartFavor || 0)
        text = '本章好感变化 ' + (delta >= 0 ? '+' : '') + delta
      }
      c.logs = c.logs || []
      c.logs.push({ chapter: chapterName, text: String(text).slice(0, 40), favor: c.favor || 0 })
    })
  }

  // ===== 章节剧情摘要（章末随剧情响应一次生成，模型漏给时用章末场景文本兜底） =====
  function recordChapterSummary(save, scene) {
    var text = (scene && scene.chapterSummary) || ''
    if (!text) text = (scene ? fullSceneText(scene) : '').slice(0, 180)
    if (!text) return
    save.chapterSummaries = save.chapterSummaries || []
    save.chapterSummaries.push({ chapter: G.chapters[save.chapterIndex].name, text: String(text) })
  }

  // ===== 选项 =====
  function showChoices(choices) {
    if (!_game) return
    var box = _game.page.querySelector('#avg-choices')
    box.innerHTML = choices.map(function(c, i) {
      return '<button class="avg-choice-btn" data-index="' + i + '" type="button">' + esc(c.text) + '</button>'
    }).join('')
    box.style.display = ''
    box.querySelectorAll('.avg-choice-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        onChoicePicked(choices[Number(btn.dataset.index)])
      })
    })
  }

  function hideChoices() {
    if (!_game) return
    var box = _game.page.querySelector('#avg-choices')
    box.style.display = 'none'
    box.innerHTML = ''
  }

  async function onChoicePicked(choice) {
    if (!_game || _game.busy) return
    var save = _game.save

    // 信物轮：章末事件的表态选择只做结算并记入 tokens，不再发起新请求（§5.4）
    if (_game.awaitingEndEventChoice) {
      _game.awaitingEndEventChoice = false
      applyEffects(save, choice.effects)
      save.tokens = choice.text
      hideChoices()
      await writeSave(save)
      await finishChapterEnd(_game.currentScene)
      return
    }

    applyEffects(save, choice.effects)

    // 章节推进判定（§5.4）：条件满足 → 下一轮注入章末事件指令
    var chapter = G.chapters[save.chapterIndex]
    if (!save.pendingChapterEnd &&
        (chapter.checkEnd(save) || save.chapterTurns >= CHAPTER_TURN_HARD_CAP)) {
      save.pendingChapterEnd = true
    }

    await writeSave(save)

    var action = save.pendingChapterEnd
      ? '我选择：「' + choice.text + '」。（系统提示：本章章末条件已达成，本轮请演出【章末事件指令】）'
      : '我选择：「' + choice.text + '」。请继续剧情。'
    requestTurn(action)
  }

  // ===== 章节结算页 =====
  async function showChapterSettle() {
    var save = _game.save
    var doneChapter = G.chapters[save.chapterIndex]
    var page = _game.page

    var favorRows = save.characters.map(function(c) {
      return '<div class="avg-settle-row"><b>' + esc(c.name) + '</b><span>好感 ' + (c.favor || 0) + '</span></div>'
    }).join('')
    var statRows = '<div class="avg-settle-row"><b>主角属性</b><span>' +
      G.statKeys.map(function(k) { return k + ' ' + (save.stats[k] || 0) }).join(' · ') + '</span></div>' +
      '<div class="avg-settle-row"><b>修罗场值</b><span>' + (save.drama || 0) + '</span></div>'

    var overlay = document.createElement('div')
    overlay.className = 'avg-settle-overlay'
    overlay.innerHTML =
      '<div class="avg-settle-card">' +
        '<div class="avg-settle-kicker">CHAPTER CLEAR</div>' +
        '<h2>' + esc(doneChapter.name) + '</h2>' +
        '<div class="avg-settle-rows">' + favorRows + statRows + '</div>' +
        '<button class="avg-primary-btn" type="button">进入下一章</button>' +
      '</div>'
    page.querySelector('.avg-rotor').appendChild(overlay)
    requestAnimationFrame(function() { overlay.classList.add('show') })

    overlay.querySelector('button').addEventListener('click', async function() {
      if (this.disabled) return   // 防连点：overlay 渐隐期间重复点击会跳章
      this.disabled = true
      overlay.classList.remove('show')
      setTimeout(function() { overlay.remove() }, 300)
      save.chapterIndex++
      save.chapterTurns = 0
      save.pendingChapterEnd = false
      save.characters.forEach(function(c) { c.chapterStartFavor = c.favor || 0 })
      // 旧章剧情已由章节摘要（前情提要）承载，仅留最近几条保持语感衔接
      save.history = save.history.slice(-4)
      updateChapterTag()
      await writeSave(save)
      var next = G.chapters[save.chapterIndex]
      requestTurn('【进入' + next.name + '】请按新的本章导演指令开启本章剧情。')
    })
  }

  // ===== 结局页 =====
  async function showEnding(scene) {
    var save = _game.save
    var page = _game.page
    var ending = G.computeEnding(save)

    var fullText = []
    if (scene) {
      if (scene.narration) fullText.push(scene.narration)
      scene.dialogues.forEach(function(d) {
        fullText.push((d.speaker ? d.speaker + '：' : '') + d.text)
      })
    }

    var overlay = document.createElement('div')
    overlay.className = 'avg-settle-overlay'
    overlay.innerHTML =
      '<div class="avg-settle-card">' +
        '<div class="avg-settle-kicker">ENDING</div>' +
        '<h2>' + esc(ending.main ? ending.main.name + '线' : '结局') + '</h2>' +
        '<div class="avg-ending-badge">' + esc(ending.label) + '</div>' +
        '<div class="avg-ending-text">' + esc(fullText.join('\n\n')) + '</div>' +
        '<button class="avg-primary-btn" type="button">回到标题</button>' +
      '</div>'
    page.querySelector('.avg-rotor').appendChild(overlay)
    requestAnimationFrame(function() { overlay.classList.add('show') })

    await setAvgConfig(gk('lastPlayedAt'), Date.now())
    await deleteSave()

    overlay.querySelector('button').addEventListener('click', function() {
      stopBgm()
      window.closePage && window.closePage('avg-game-page')
      window.closePage && window.closePage('avg-title-page')
      _game = null
      showAvgTitlePage()
    })
  }

  // ===== 攻略面板（抽屉） =====
  function suspicionText(save, name) {
    var v = save.suspicion && save.suspicion[name]
    return (v === '低' || v === '中' || v === '高') ? v : '低'
  }

  function openStrategyPanel() {
    if (!_game) return
    var save = _game.save
    var page = _game.page
    var overlay = page.querySelector('#avg-panel-overlay')
    var panel = page.querySelector('#avg-panel')

    var favorBars = save.characters.map(function(c, i) {
      var meta = esc(c.seat) +
        (G.hasSuspicion ? ' · 疑心 ' + esc(suspicionText(save, c.name)) : '') +
        ' · 点击查看资料'
      return '<div class="avg-bar-row avg-panel-row" data-index="' + i + '">' +
        '<div class="avg-bar-label"><b>' + esc(c.name) + '<small>' + meta + '</small></b><span>' + (c.favor || 0) + '</span></div>' +
        '<div class="avg-bar"><span style="width:' + (c.favor || 0) + '%"></span></div>' +
      '</div>'
    }).join('')

    var statBars = G.statKeys.map(function(k) {
      var v = (save.stats && save.stats[k]) || 0
      return '<div class="avg-bar-row">' +
        '<div class="avg-bar-label"><b>' + k + '</b><span>' + v + '</span></div>' +
        '<div class="avg-bar"><span style="width:' + v + '%"></span></div>' +
      '</div>'
    }).join('')

    var events = save.unlockedEvents.length
      ? save.unlockedEvents.map(function(e) {
          return '<div class="avg-event-item"><b>' + esc(e.chapter) + '</b>' + esc(e.note || '') + '</div>'
        }).join('')
      : '<div class="avg-panel-empty">暂无已解锁事件</div>'

    panel.innerHTML =
      '<h3>攻略面板</h3>' +
      '<button class="avg-recap-btn" id="avg-recap-btn" type="button">回顾剧情</button>' +
      '<div class="avg-panel-section">角色好感</div>' + favorBars +
      '<div class="avg-panel-section">主角属性</div>' + statBars +
      '<div class="avg-panel-section">修罗场值</div>' +
      '<div class="avg-bar-row">' +
        '<div class="avg-bar-label"><b>全局张力</b><span>' + (save.drama || 0) + '</span></div>' +
        '<div class="avg-bar is-drama"><span style="width:' + (save.drama || 0) + '%"></span></div>' +
      '</div>' +
      '<div class="avg-panel-section">已解锁事件</div>' + events

    overlay.style.display = ''
    requestAnimationFrame(function() {
      overlay.classList.add('show')
      panel.classList.add('show')
    })
    overlay.onclick = function() {
      overlay.classList.remove('show')
      panel.classList.remove('show')
      setTimeout(function() { overlay.style.display = 'none' }, 250)
    }

    panel.querySelectorAll('.avg-panel-row').forEach(function(row) {
      row.addEventListener('click', function() {
        var c = save.characters[Number(row.dataset.index)]
        if (c) openProfileCard(c)
      })
    })
    var recapBtn = panel.querySelector('#avg-recap-btn')
    if (recapBtn) recapBtn.addEventListener('click', openStoryRecap)
  }

  // ===== 设置弹窗（音乐开关 / 搜索音乐 / 返回主页） =====
  function searchBgm(keyword) {
    // moeyao meting 不支持关键词搜索，主用 gdstudio search，失败退 meting 镜像
    var gdUrl = 'https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=' +
      encodeURIComponent(keyword) + '&count=20&pages=1'
    var metingUrl = 'https://api.qijieya.cn/meting/?server=netease&type=search&id=' +
      encodeURIComponent(keyword) + '&limit=20'
    function normalize(list) {
      return list.map(function(item) {
        var id = item.id || (String(item.url || '').match(/[?&]id=([^&]+)/) || [])[1] || ''
        var artist = Array.isArray(item.artist) ? item.artist.join('/') : (item.artist || '')
        return { id: id, name: item.name || item.title || '', artist: artist }
      }).filter(function(s) { return s.id && s.name })
    }
    return fetch(gdUrl)
      .then(function(res) { return res.json() })
      .then(function(data) {
        if (!Array.isArray(data) || !data.length) throw new Error('empty')
        return normalize(data)
      })
      .catch(function() {
        return fetch(metingUrl)
          .then(function(res) { return res.json() })
          .then(function(data) {
            if (!Array.isArray(data) || !data.length) throw new Error('empty')
            return normalize(data)
          })
      })
  }

  function openSettingsPanel() {
    if (!_game) return
    var page = _game.page
    var overlay = page.querySelector('#avg-panel-overlay')
    var panel = page.querySelector('#avg-panel')

    panel.innerHTML =
      '<h3>游戏设置</h3>' +
      '<div class="avg-panel-section">背景音乐</div>' +
      '<div class="avg-setting-row">' +
        '<span>开启音乐</span>' +
        '<button class="avg-switch' + (_bgm.on ? ' on' : '') + '" id="avg-bgm-switch" type="button"></button>' +
      '</div>' +
      '<div class="avg-bgm-now" id="avg-bgm-now">当前播放：' + esc(_bgm.name) + '</div>' +
      '<div class="avg-panel-section">搜索音乐</div>' +
      '<div class="avg-bgm-search">' +
        '<input type="text" id="avg-bgm-input" placeholder="搜索歌曲、歌手" autocomplete="off">' +
        '<button type="button" id="avg-bgm-search-btn">搜索</button>' +
      '</div>' +
      '<div class="avg-bgm-results" id="avg-bgm-results"></div>' +
      '<div class="avg-panel-section">操作</div>' +
      '<button class="avg-recap-btn" id="avg-btn-home" type="button">返回主页</button>'

    overlay.style.display = ''
    requestAnimationFrame(function() {
      overlay.classList.add('show')
      panel.classList.add('show')
    })
    overlay.onclick = function() {
      overlay.classList.remove('show')
      panel.classList.remove('show')
      setTimeout(function() { overlay.style.display = 'none' }, 250)
    }

    // 音乐开关（会话级，不持久化）
    var switchBtn = panel.querySelector('#avg-bgm-switch')
    switchBtn.addEventListener('click', function() {
      _bgm.on = !_bgm.on
      switchBtn.classList.toggle('on', _bgm.on)
      if (_bgm.on) playBgm(_bgm.id || G.bgmId, _bgm.name)
      else stopBgm()
    })

    // 搜索音乐
    var input = panel.querySelector('#avg-bgm-input')
    var results = panel.querySelector('#avg-bgm-results')
    function doSearch() {
      var keyword = input.value.trim()
      if (!keyword) return
      results.innerHTML = '<div class="avg-panel-empty">搜索中…</div>'
      searchBgm(keyword)
        .then(function(songs) {
          if (!songs.length) throw new Error('empty')
          results.innerHTML = songs.map(function(s, i) {
            return '<div class="avg-bgm-item" data-index="' + i + '">' +
              '<b>' + esc(s.name) + '</b><small>' + esc(s.artist) + '</small></div>'
          }).join('')
          results.querySelectorAll('.avg-bgm-item').forEach(function(row) {
            row.addEventListener('click', function() {
              var s = songs[Number(row.dataset.index)]
              if (!s) return
              var songName = s.name + (s.artist ? ' - ' + s.artist : '')
              _bgm.on = true
              switchBtn.classList.add('on')
              playBgm(s.id, songName)
              panel.querySelector('#avg-bgm-now').textContent = '当前播放：' + songName
              results.querySelectorAll('.avg-bgm-item').forEach(function(r) { r.classList.remove('playing') })
              row.classList.add('playing')
            })
          })
        })
        .catch(function() {
          results.innerHTML = '<div class="avg-panel-empty">搜索失败，请重试</div>'
        })
    }
    panel.querySelector('#avg-bgm-search-btn').addEventListener('click', doSearch)
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSearch() })

    // 返回主页：停音乐 → 保存进度 → 关页
    panel.querySelector('#avg-btn-home').addEventListener('click', async function() {
      stopBgm()
      if (_game && _game.save && !_game.save.ended) await writeSave(_game.save)
      window.closePage && window.closePage('avg-game-page')
      _game = null
    })
  }

  // ===== 回顾剧情（按章分组：摘要 + 每轮全文） =====
  function openStoryRecap() {
    if (!_game) return
    var save = _game.save
    var summaryMap = {}
    ;(save.chapterSummaries || []).forEach(function(s) { summaryMap[s.chapter] = s.text })

    // storyLog 按章分组（时间正序）
    var groups = []
    ;(save.storyLog || []).forEach(function(entry) {
      var last = groups[groups.length - 1]
      if (!last || last.chapter !== entry.chapter) {
        last = { chapter: entry.chapter, turns: [] }
        groups.push(last)
      }
      last.turns.push(entry)
    })

    var currentChapter = G.chapters[save.chapterIndex].name
    var body = groups.length
      ? groups.map(function(g) {
          var summary = summaryMap[g.chapter]
          var summaryHTML = summary
            ? '<div class="avg-recap-summary"><b>本章摘要</b>' + esc(summary) + '</div>'
            : (g.chapter === currentChapter
                ? '<div class="avg-recap-summary is-pending">本章进行中，章末自动生成摘要</div>'
                : '')
          var turnsHTML = g.turns.map(function(t) {
            return '<div class="avg-recap-turn">' +
              (t.action ? '<div class="avg-recap-action">▸ ' + esc(t.action) + '</div>' : '') +
              '<div class="avg-recap-text">' + esc(t.text) + '</div>' +
            '</div>'
          }).join('')
          return '<div class="avg-recap-chapter">' +
            '<div class="avg-recap-chapter-name">' + esc(g.chapter) + '</div>' +
            summaryHTML + turnsHTML +
          '</div>'
        }).join('')
      : '<div class="avg-panel-empty">暂无剧情记录，开始游戏后自动记录</div>'

    var overlay = document.createElement('div')
    overlay.className = 'avg-settle-overlay'
    overlay.innerHTML =
      '<div class="avg-profile-card avg-recap-card">' +
        '<h3>回顾剧情</h3>' +
        body +
      '</div>'
    _game.page.querySelector('.avg-rotor').appendChild(overlay)
    requestAnimationFrame(function() { overlay.classList.add('show') })
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) {
        overlay.classList.remove('show')
        setTimeout(function() { overlay.remove() }, 300)
      }
    })
  }

  // ===== 角色资料卡 =====
  function openProfileCard(c) {
    if (!_game) return
    var save = _game.save
    var favor = c.favor || 0
    var logs = (c.logs || []).slice().reverse()
    var logsHTML = logs.length
      ? logs.map(function(l) {
          return '<div class="avg-log-item">' +
            '<span class="avg-log-chapter">' + esc(String(l.chapter || '').split(' · ')[0]) + '</span>' +
            '<span class="avg-log-text">' + esc(l.text || '') + '</span>' +
            '<span class="avg-log-favor">好感 ' + (l.favor || 0) + '</span>' +
          '</div>'
        }).join('')
      : '<div class="avg-panel-empty">暂无互动记录，每章结束后自动记录</div>'

    var metaLine = esc(c.gender || '未知') + ' · ' + esc(c.seat) +
      (G.hasSuspicion ? ' · 疑心 ' + esc(suspicionText(save, c.name)) : '')

    var overlay = document.createElement('div')
    overlay.className = 'avg-settle-overlay'
    overlay.innerHTML =
      '<div class="avg-profile-card">' +
        '<div class="avg-profile-head">' +
          '<div class="avg-profile-avatar">' + avatarHTML(c.name, c.avatar) + '</div>' +
          '<div>' +
            '<div class="avg-profile-name">' + esc(c.name) + '</div>' +
            '<div class="avg-profile-meta">' + metaLine + '</div>' +
          '</div>' +
        '</div>' +
        tagsHTML(c.tags) +
        '<div class="avg-profile-section">攻略进度</div>' +
        '<div class="avg-profile-stage"><b>' + esc(G.favorStageText(favor)) + '</b><span>好感 ' + favor + ' / 100</span></div>' +
        '<div class="avg-bar"><span style="width:' + favor + '%"></span></div>' +
        '<div class="avg-profile-section">互动记录</div>' +
        logsHTML +
      '</div>'
    _game.page.querySelector('.avg-rotor').appendChild(overlay)
    requestAnimationFrame(function() { overlay.classList.add('show') })
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) {
        overlay.classList.remove('show')
        setTimeout(function() { overlay.remove() }, 300)
      }
    })
  }

  // ===== 请求异常展示 =====
  function setDialogLoading(text) {
    var page = _game.page
    page.querySelector('#avg-nametag').classList.add('is-hidden')
    page.querySelector('#avg-next-hint').style.display = 'none'
    page.querySelector('#avg-dialog-text').innerHTML =
      esc(text || '剧情生成中') + '<span class="avg-loading-dots"><i>.</i><i>.</i><i>.</i></span>'
  }

  function showRetryUI(message) {
    var page = _game.page
    page.querySelector('#avg-nametag').classList.add('is-hidden')
    page.querySelector('#avg-next-hint').style.display = 'none'
    var textEl = page.querySelector('#avg-dialog-text')
    textEl.innerHTML = esc(message) +
      '<br><button class="avg-retry-btn" type="button">重试</button>'
    textEl.querySelector('.avg-retry-btn').addEventListener('click', function(e) {
      e.stopPropagation()
      var action = _game.pendingAction
      if (action) requestTurn(action)
    })
  }

  function showPlainFallback(rawText) {
    showRetryUI('（剧情格式解析失败，以下为原始输出）\n' + rawText)
  }

  function showRequestError(message) {
    showRetryUI('剧情生成失败：' + message)
  }
})()
