/**
 * VocabMeld 内容脚本
 * 注入到网页中，处理词汇替换和用户交互
 */

// 由于 content script 不支持 ES modules，我们需要将所有代码整合

(async function() {
  'use strict';

  // ============ 配置常量 ============
  const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const INTENSITY_CONFIG = {
    low: { maxPerParagraph: 4 },
    medium: { maxPerParagraph: 8 },
    high: { maxPerParagraph: 14 }
  };
  const SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CODE', 'PRE', 'KBD', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON'];
  const SKIP_CLASSES = ['vocabmeld-translated', 'vocabmeld-tooltip', 'hljs', 'code', 'syntax'];
  const CACHE_MAX_SIZE = 2000;

  // ============ 状态管理 ============
  let config = null;
  let isProcessing = false;
  let processedFingerprints = new Set();
  let wordCache = new Map();
  let tooltip = null;
  let selectionPopup = null;

  // ============ 工具函数 ============
  function isDifficultyCompatible(wordDifficulty, userDifficulty) {
    const wordIdx = CEFR_LEVELS.indexOf(wordDifficulty);
    const userIdx = CEFR_LEVELS.indexOf(userDifficulty);
    return wordIdx >= userIdx;
  }

  function generateFingerprint(text, path = '') {
    const content = text.slice(0, 100).trim();
    let hash = 0;
    const str = content + path;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  function debounce(func, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  function detectLanguage(text) {
    const chineseRegex = /[\u4e00-\u9fff]/g;
    const japaneseRegex = /[\u3040-\u309f\u30a0-\u30ff]/g;
    const koreanRegex = /[\uac00-\ud7af]/g;
    const latinRegex = /[a-zA-Z]/g;

    const chineseCount = (text.match(chineseRegex) || []).length;
    const japaneseCount = (text.match(japaneseRegex) || []).length;
    const koreanCount = (text.match(koreanRegex) || []).length;
    const latinCount = (text.match(latinRegex) || []).length;
    const total = chineseCount + japaneseCount + koreanCount + latinCount || 1;

    if (japaneseCount / total > 0.1) return 'ja';
    if (koreanCount / total > 0.1) return 'ko';
    if (chineseCount / total > 0.3) return 'zh-CN';
    return 'en';
  }

  function isCodeText(text) {
    const codePatterns = [
      /^(const|let|var|function|class|import|export|return|if|else|for|while)\s/,
      /[{}();]\s*$/,
      /^\s*(\/\/|\/\*|\*|#)/,
      /\w+\.\w+\(/,
      /console\./,
      /https?:\/\//
    ];
    return codePatterns.some(pattern => pattern.test(text.trim()));
  }

  // 重建文本，只保留指定的词汇（用于发送给 AI）
  function reconstructTextWithWords(text, targetWords) {
    const targetWordSet = new Set(targetWords.map(w => w.toLowerCase()));
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);

    const relevantSentences = sentences.filter(sentence => {
      const words = sentence.match(/\b[a-zA-Z]{3,}\b/g) || [];
      const chineseWords = sentence.match(/[\u4e00-\u9fff]{2,4}/g) || [];
      const allWords = [...words, ...chineseWords];
      return allWords.some(word => targetWordSet.has(word.toLowerCase()));
    });

    return relevantSentences.join('. ').trim() + (relevantSentences.length > 0 ? '.' : '');
  }

  // ============ 存储操作 ============
  async function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(null, (result) => {
        config = {
          apiEndpoint: result.apiEndpoint || 'https://api.deepseek.com/chat/completions',
          apiKey: result.apiKey || '',
          modelName: result.modelName || 'deepseek-chat',
          nativeLanguage: result.nativeLanguage || 'zh-CN',
          targetLanguage: result.targetLanguage || 'en',
          difficultyLevel: result.difficultyLevel || 'B1',
          intensity: result.intensity || 'medium',
          autoProcess: result.autoProcess ?? false,
          showPhonetic: result.showPhonetic ?? true,
          enabled: result.enabled ?? true,
          blacklist: result.blacklist || [],
          whitelist: result.whitelist || [],
          learnedWords: result.learnedWords || [],
          memorizeList: result.memorizeList || []
        };
        resolve(config);
      });
    });
  }

  async function loadWordCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get('vocabmeld_word_cache', (result) => {
        const cached = result.vocabmeld_word_cache;
        if (cached && Array.isArray(cached)) {
          cached.forEach(item => {
            wordCache.set(item.key, {
              translation: item.translation,
              phonetic: item.phonetic,
              difficulty: item.difficulty
            });
          });
        }
        resolve(wordCache);
      });
    });
  }

  async function saveWordCache() {
    const data = [];
    for (const [key, value] of wordCache) {
      data.push({ key, ...value });
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ vocabmeld_word_cache: data }, resolve);
    });
  }

  async function updateStats(stats) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['totalWords', 'todayWords', 'lastResetDate', 'cacheHits', 'cacheMisses'], (current) => {
        const today = new Date().toISOString().split('T')[0];
        if (current.lastResetDate !== today) {
          current.todayWords = 0;
          current.lastResetDate = today;
        }
        const updated = {
          totalWords: (current.totalWords || 0) + (stats.newWords || 0),
          todayWords: (current.todayWords || 0) + (stats.newWords || 0),
          lastResetDate: today,
          cacheHits: (current.cacheHits || 0) + (stats.cacheHits || 0),
          cacheMisses: (current.cacheMisses || 0) + (stats.cacheMisses || 0)
        };
        chrome.storage.sync.set(updated, () => resolve(updated));
      });
    });
  }

  async function addToWhitelist(original, translation) {
    const whitelist = config.learnedWords || [];
    const exists = whitelist.some(w => w.original === original || w.word === translation);
    if (!exists) {
      whitelist.push({ original, word: translation, addedAt: Date.now() });
      config.learnedWords = whitelist;
      await new Promise(resolve => chrome.storage.sync.set({ learnedWords: whitelist }, resolve));
    }
  }

  async function addToMemorizeList(word) {
    const list = config.memorizeList || [];
    const exists = list.some(w => w.word === word);
    if (!exists) {
      list.push({ word, addedAt: Date.now() });
      config.memorizeList = list;
      await new Promise(resolve => chrome.storage.sync.set({ memorizeList: list }, resolve));
    }
  }

  // ============ DOM 处理 ============
  function shouldSkipNode(node) {
    if (!node) return true;
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) return true;
    if (node.nodeType === Node.TEXT_NODE) return shouldSkipNode(node.parentElement);

    const element = node;
    if (SKIP_TAGS.includes(element.tagName)) return true;
    const classList = element.className?.toString() || '';
    if (SKIP_CLASSES.some(cls => classList.includes(cls))) return true;

    try {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    } catch (e) {}

    if (element.isContentEditable) return true;
    if (element.hasAttribute('data-vocabmeld-processed')) return true;

    return false;
  }

  function getElementPath(element) {
    const parts = [];
    let current = element;
    while (current && current !== document.body) {
      let selector = current.tagName?.toLowerCase() || '';
      if (current.id) selector += `#${current.id}`;
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join('>');
  }

  function findTextContainers(root) {
    const containers = [];
    const blockTags = ['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'BLOCKQUOTE'];
    
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        if (blockTags.includes(node.tagName)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });

    let node;
    while (node = walker.nextNode()) {
      const hasDirectText = Array.from(node.childNodes).some(
        child => child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 10
      );
      if (hasDirectText) containers.push(node);
    }
    return containers;
  }

  function getTextContent(element) {
    const texts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (shouldSkipNode(node.parentElement)) return NodeFilter.FILTER_REJECT;
        const text = node.textContent.trim();
        if (text.length > 0 && !isCodeText(text)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    });

    let node;
    while (node = walker.nextNode()) texts.push(node.textContent);
    return texts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function getPageSegments(viewportOnly = false, margin = 300) {
    const segments = [];
    let viewportTop = 0, viewportBottom = Infinity;
    
    if (viewportOnly) {
      viewportTop = window.scrollY - margin;
      viewportBottom = window.scrollY + window.innerHeight + margin;
    }

    const containers = findTextContainers(document.body);

    for (const container of containers) {
      if (viewportOnly) {
        const rect = container.getBoundingClientRect();
        const elementTop = rect.top + window.scrollY;
        const elementBottom = rect.bottom + window.scrollY;
        if (elementBottom < viewportTop || elementTop > viewportBottom) continue;
      }

      const text = getTextContent(container);
      if (!text || text.length < 50) continue;
      if (isCodeText(text)) continue;

      const path = getElementPath(container);
      const fingerprint = generateFingerprint(text, path);
      if (processedFingerprints.has(fingerprint)) continue;

      segments.push({ element: container, text: text.slice(0, 2000), fingerprint, path });
    }

    return segments;
  }

  // ============ 文本替换 ============
  function createReplacementElement(original, translation, phonetic, difficulty) {
    const wrapper = document.createElement('span');
    wrapper.className = 'vocabmeld-translated';
    wrapper.setAttribute('data-original', original);
    wrapper.setAttribute('data-translation', translation);
    wrapper.setAttribute('data-phonetic', phonetic || '');
    wrapper.setAttribute('data-difficulty', difficulty || 'B1');
    wrapper.innerHTML = `<span class="vocabmeld-word">${translation}</span><span class="vocabmeld-original">(${original})</span>`;
    return wrapper;
  }

  function applyReplacements(element, replacements) {
    if (!element || !replacements?.length) return 0;

    let count = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.trim().length > 0) textNodes.push(node);
    }

    const sortedReplacements = [...replacements].sort((a, b) => (b.position || 0) - (a.position || 0));

    for (const replacement of sortedReplacements) {
      const { original, translation, phonetic, difficulty } = replacement;
      
      for (const textNode of textNodes) {
        const text = textNode.textContent;
        const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|[\\s，。、；：""''（）\\[\\]【】])${escapedOriginal}([\\s，。、；：""''（）\\[\\]【】]|$)`, 'i');
        
        let match = regex.exec(text);
        let startIndex = match ? match.index + match[1].length : text.indexOf(original);
        
        if (startIndex === -1) continue;

        try {
          const range = document.createRange();
          range.setStart(textNode, startIndex);
          range.setEnd(textNode, startIndex + original.length);
          
          const rangeContent = range.toString();
          if (rangeContent.toLowerCase() !== original.toLowerCase()) continue;

          const wrapper = createReplacementElement(original, translation, phonetic, difficulty);
          range.deleteContents();
          range.insertNode(wrapper);
          count++;
          break;
        } catch (e) {
          console.error('[VocabMeld] Replacement error:', e);
        }
      }
    }

    if (count > 0) element.setAttribute('data-vocabmeld-processed', 'true');
    return count;
  }

  function restoreOriginal(element) {
    if (!element.classList?.contains('vocabmeld-translated')) return;
    const original = element.getAttribute('data-original');
    const textNode = document.createTextNode(original);
    element.parentNode.replaceChild(textNode, element);
  }

  function restoreAll() {
    document.querySelectorAll('.vocabmeld-translated').forEach(restoreOriginal);
    document.querySelectorAll('[data-vocabmeld-processed]').forEach(el => el.removeAttribute('data-vocabmeld-processed'));
    processedFingerprints.clear();
  }

  // ============ API 调用 ============
  async function translateText(text) {
    if (!config.apiKey || !config.apiEndpoint) {
      throw new Error('API 未配置');
    }

    const sourceLang = detectLanguage(text);
    const targetLang = sourceLang === config.nativeLanguage ? config.targetLanguage : config.nativeLanguage;
    const maxReplacements = INTENSITY_CONFIG[config.intensity]?.maxPerParagraph || 8;

    // 检查缓存 - 只检查有意义的词汇（排除常见停用词）
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their']);
    
    const words = (text.match(/\b[a-zA-Z]{3,}\b/g) || []).filter(w => !stopWords.has(w.toLowerCase()));
    const chineseWords = text.match(/[\u4e00-\u9fff]{2,4}/g) || [];
    const allWords = [...new Set([...words, ...chineseWords])];

    const cached = [];
    const uncached = [];

    for (const word of allWords) {
      const key = `${word.toLowerCase()}:${sourceLang}:${targetLang}`;
      if (wordCache.has(key)) {
        cached.push({ word, ...wordCache.get(key) });
      } else {
        uncached.push(word);
      }
    }

    // 如果缓存中有足够的词汇，直接返回（不需要所有词都命中）
    const filteredCached = cached.filter(c => isDifficultyCompatible(c.difficulty || 'B1', config.difficultyLevel));

    // 改进的缓存策略：只要有缓存词汇就优先使用，而不是要求达到maxReplacements
    // 这样可以显著提升缓存命中率和响应速度
    if (filteredCached.length > 0) {
      const useCount = Math.min(filteredCached.length, maxReplacements);
      // 异步更新统计，不阻塞返回
      updateStats({ cacheHits: useCount, cacheMisses: 0 });
      return filteredCached
        .slice(0, useCount)
        .map(c => {
          const idx = text.toLowerCase().indexOf(c.word.toLowerCase());
          return { original: c.word, translation: c.translation, phonetic: c.phonetic, difficulty: c.difficulty, position: idx, fromCache: true };
        });
    }

    // 如果没有未缓存的词汇，或者缓存词汇足够多，直接返回缓存结果
    if (uncached.length === 0 || filteredCached.length >= Math.min(3, maxReplacements)) {
      const useCount = Math.min(filteredCached.length, maxReplacements);
      updateStats({ cacheHits: useCount, cacheMisses: 0 });
      return filteredCached
        .slice(0, useCount)
        .map(c => {
          const idx = text.toLowerCase().indexOf(c.word.toLowerCase());
          return { original: c.word, translation: c.translation, phonetic: c.phonetic, difficulty: c.difficulty, position: idx, fromCache: true };
        });
    }

    // 构建只包含未缓存词汇的文本用于发送给 AI
    const filteredText = reconstructTextWithWords(text, uncached);

    // 如果过滤后的文本太短，直接返回缓存结果
    if (filteredText.trim().length < 50) {
      updateStats({ cacheHits: filteredCached.length, cacheMisses: 0 });
      return filteredCached
        .map(c => {
          const idx = text.toLowerCase().indexOf(c.word.toLowerCase());
          return { original: c.word, translation: c.translation, phonetic: c.phonetic, difficulty: c.difficulty, position: idx, fromCache: true };
        }).slice(0, maxReplacements);
    }

    // 调用 API，只处理未缓存的词汇
    const prompt = `你是一个语言学习助手。请分析以下文本，选择适合学习的词汇进行翻译。

## 规则：
1. 选择 15-20 个左右有学习价值的词汇
2. 避免替换：专有名词、人名、地名、品牌名、数字、代码、URL、已经是目标语言的词
3. 优先选择：常用词汇、有学习价值的词汇、不同难度级别的词汇
4. 翻译方向：从 ${sourceLang} 翻译到 ${targetLang}
5. 翻译倾向：结合上下文，夹杂起来也能容易被理解，尽量只翻译成最合适的词汇，而不是多个含义。

## CEFR等级从简单到复杂依次为：A1-C2

## 输出格式：
返回 JSON 数组，每个元素包含：
- original: 原词
- translation: 翻译结果
- phonetic: 学习语言(${config.targetLanguage})的音标/发音
- difficulty: CEFR 难度等级 (A1/A2/B1/B2/C1/C2)，请谨慎评估
- position: 在文本中的起始位置

## 文本：
${filteredText}

## 输出：
只返回 JSON 数组，不要其他内容。`;

    try {
      const response = await fetch(config.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            { role: 'system', content: '你是一个专业的语言学习助手。始终返回有效的 JSON 格式。' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 2000
        })
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `API Error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '[]';
      
      let allResults = [];
      try {
        allResults = JSON.parse(content);
        if (!Array.isArray(allResults)) {
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) allResults = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) allResults = JSON.parse(jsonMatch[0]);
      }

      // 先缓存所有词汇（包括所有难度级别），供不同难度设置的用户使用
      for (const item of allResults) {
        const key = `${item.original.toLowerCase()}:${sourceLang}:${targetLang}`;
        wordCache.set(key, {
          translation: item.translation,
          phonetic: item.phonetic || '',
          difficulty: item.difficulty || 'B1'
        });
        
        // LRU 淘汰
        if (wordCache.size > CACHE_MAX_SIZE) {
          const firstKey = wordCache.keys().next().value;
          wordCache.delete(firstKey);
        }
      }
      saveWordCache();

      // 本地过滤：只保留符合用户难度设置的词汇
      const filteredResults = allResults.filter(item => isDifficultyCompatible(item.difficulty || 'B1', config.difficultyLevel));

      // 异步更新统计，不阻塞返回
      updateStats({ newWords: filteredResults.length, cacheHits: cached.length, cacheMisses: 1 });

      // 修正 AI 返回结果的位置（从过滤文本映射回原始文本）
      const correctedResults = filteredResults.map(result => {
        const originalIndex = text.toLowerCase().indexOf(result.original.toLowerCase());
        return {
          ...result,
          position: originalIndex >= 0 ? originalIndex : result.position
        };
      });

      // 合并缓存结果（去重，优先使用缓存结果以提升响应速度）
      const resultWords = new Set(correctedResults.map(r => r.original.toLowerCase()));
      const cachedResults = cached
        .filter(c => !resultWords.has(c.word.toLowerCase()) && isDifficultyCompatible(c.difficulty || 'B1', config.difficultyLevel))
        .map(c => {
          const idx = text.toLowerCase().indexOf(c.word.toLowerCase());
          return { original: c.word, translation: c.translation, phonetic: c.phonetic, difficulty: c.difficulty, position: idx, fromCache: true };
        });

      // 优先使用缓存结果，补充API结果
      const mergedResults = [...cachedResults, ...correctedResults];
      return mergedResults.slice(0, maxReplacements);

    } catch (error) {
      console.error('[VocabMeld] API Error:', error);
      throw error;
    }
  }

  // ============ 页面处理 ============
  const MAX_CONCURRENT = 3; // 最大并发请求数

  async function processPage(viewportOnly = false) {
    if (isProcessing) return { processed: 0, skipped: true };
    if (!config?.enabled) return { processed: 0, disabled: true };

    // 检查黑名单
    const hostname = window.location.hostname;
    if (config.blacklist?.some(domain => hostname.includes(domain))) {
      return { processed: 0, blacklisted: true };
    }

    isProcessing = true;
    let processed = 0, errors = 0;

    try {
      const segments = getPageSegments(viewportOnly);
      console.log(`[VocabMeld] Found ${segments.length} segments to process`);

      const whitelistWords = new Set((config.learnedWords || []).map(w => w.original.toLowerCase()));

      // 预处理：过滤有效的 segments
      const validSegments = [];
      for (const segment of segments) {
        let text = segment.text;
        for (const word of whitelistWords) {
          const regex = new RegExp(`\\b${word}\\b`, 'gi');
          text = text.replace(regex, '');
        }
        if (text.trim().length >= 30) {
          validSegments.push({ ...segment, filteredText: text });
        }
      }

      // 并行处理单个 segment
      async function processSegment(segment) {
        try {
          const replacements = await translateText(segment.filteredText);
          if (replacements?.length) {
            const filtered = replacements.filter(r => !whitelistWords.has(r.original.toLowerCase()));
            const count = applyReplacements(segment.element, filtered);
            processedFingerprints.add(segment.fingerprint);
            return { count, error: false };
          }
          return { count: 0, error: false };
        } catch (e) {
          console.error('[VocabMeld] Segment error:', e);
          return { count: 0, error: true };
        }
      }

      // 分批并行处理（控制并发数）
      for (let i = 0; i < validSegments.length; i += MAX_CONCURRENT) {
        const batch = validSegments.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(batch.map(processSegment));
        
        for (const result of results) {
          processed += result.count;
          if (result.error) errors++;
        }
      }

      console.log(`[VocabMeld] Processed ${processed} words`);
      return { processed, errors };
    } finally {
      isProcessing = false;
    }
  }

  // ============ UI 组件 ============
  function createTooltip() {
    if (tooltip) return;
    
    tooltip = document.createElement('div');
    tooltip.className = 'vocabmeld-tooltip';
    tooltip.style.display = 'none';
    document.body.appendChild(tooltip);
  }

  function showTooltip(element) {
    if (!tooltip || !element.classList?.contains('vocabmeld-translated')) return;

    const original = element.getAttribute('data-original');
    const translation = element.getAttribute('data-translation');
    const phonetic = element.getAttribute('data-phonetic');
    const difficulty = element.getAttribute('data-difficulty');

    tooltip.innerHTML = `
      <div class="vocabmeld-tooltip-header">
        <span class="vocabmeld-tooltip-word">${translation}</span>
        <span class="vocabmeld-tooltip-badge">${difficulty}</span>
      </div>
      ${phonetic && config.showPhonetic ? `<div class="vocabmeld-tooltip-phonetic">${phonetic}</div>` : ''}
      <div class="vocabmeld-tooltip-original">原文: ${original}</div>
      <div class="vocabmeld-tooltip-tip">左键点击发音 · 右键标记已学会</div>
    `;

    const rect = element.getBoundingClientRect();
    tooltip.style.left = rect.left + window.scrollX + 'px';
    tooltip.style.top = rect.bottom + window.scrollY + 5 + 'px';
    tooltip.style.display = 'block';
  }

  function hideTooltip() {
    if (tooltip) tooltip.style.display = 'none';
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'vocabmeld-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('vocabmeld-toast-show'), 10);
    setTimeout(() => {
      toast.classList.remove('vocabmeld-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  function createSelectionPopup() {
    if (selectionPopup) return;
    
    selectionPopup = document.createElement('div');
    selectionPopup.className = 'vocabmeld-selection-popup';
    selectionPopup.style.display = 'none';
    selectionPopup.innerHTML = '<button class="vocabmeld-add-memorize">添加到需记忆</button>';
    document.body.appendChild(selectionPopup);

    selectionPopup.querySelector('button').addEventListener('click', async () => {
      const selection = window.getSelection();
      const text = selection.toString().trim();
      if (text && text.length < 50) {
        await addToMemorizeList(text);
        showToast(`"${text}" 已添加到需记忆列表`);
      }
      selectionPopup.style.display = 'none';
    });
  }

  // ============ 事件处理 ============
  function setupEventListeners() {
    // 悬停显示提示 - 使用 mouseenter/mouseleave 更稳定
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('.vocabmeld-translated');
      if (target) {
        showTooltip(target);
      }
    });

    document.addEventListener('mouseout', (e) => {
      const target = e.target.closest('.vocabmeld-translated');
      const relatedTarget = e.relatedTarget;
      
      // 只有当鼠标移出到非翻译元素和非tooltip时才隐藏
      if (target && 
          !relatedTarget?.closest('.vocabmeld-translated') && 
          !relatedTarget?.closest('.vocabmeld-tooltip')) {
        hideTooltip();
      }
    });
    
    // 鼠标移出 tooltip 时也隐藏
    document.addEventListener('mouseout', (e) => {
      if (e.target.closest('.vocabmeld-tooltip') && 
          !e.relatedTarget?.closest('.vocabmeld-tooltip') &&
          !e.relatedTarget?.closest('.vocabmeld-translated')) {
        hideTooltip();
      }
    });

    // 左键点击发音
    document.addEventListener('click', (e) => {
      const target = e.target.closest('.vocabmeld-translated');
      if (target) {
        const word = target.getAttribute('data-translation');
        const lang = config.targetLanguage === 'en' ? 'en-US' : 
                     config.targetLanguage === 'zh-CN' ? 'zh-CN' :
                     config.targetLanguage === 'ja' ? 'ja-JP' :
                     config.targetLanguage === 'ko' ? 'ko-KR' : 'en-US';
        
        chrome.runtime.sendMessage({ action: 'speak', text: word, lang });
      }
    });

    // 右键标记已学会
    document.addEventListener('contextmenu', async (e) => {
      const target = e.target.closest('.vocabmeld-translated');
      if (target) {
        e.preventDefault();
        const original = target.getAttribute('data-original');
        const translation = target.getAttribute('data-translation');
        await addToWhitelist(original, translation);
        restoreOriginal(target);
        hideTooltip(); // 隐藏tooltip
        showToast(`"${original}" 已标记为已学会`);
      }
    });

    // 选择文本显示添加按钮
    document.addEventListener('mouseup', (e) => {
      if (e.target.closest('.vocabmeld-selection-popup')) return;
      
      setTimeout(() => {
        const selection = window.getSelection();
        const text = selection.toString().trim();
        
        if (text && text.length > 1 && text.length < 50 && !e.target.closest('.vocabmeld-translated')) {
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          
          selectionPopup.style.left = rect.left + window.scrollX + 'px';
          selectionPopup.style.top = rect.bottom + window.scrollY + 5 + 'px';
          selectionPopup.style.display = 'block';
        } else {
          selectionPopup.style.display = 'none';
        }
      }, 10);
    });

    // 滚动处理（懒加载）
    const handleScroll = debounce(() => {
      if (config?.autoProcess && config?.enabled) {
        processPage(true);
      }
    }, 500);
    window.addEventListener('scroll', handleScroll, { passive: true });

    // 监听配置变化
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync') {
        loadConfig().then(() => {
          if (changes.enabled?.newValue === false) {
            restoreAll();
          }
          // 难度或强度变化时，需要重新处理页面
          if (changes.difficultyLevel || changes.intensity) {
            restoreAll(); // 先恢复页面（会清除 processedFingerprints）
            if (config.enabled) {
              processPage(); // 重新处理
            }
          }
        });
      }
    });

    // 监听来自 popup 或 background 的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'processPage') {
        processPage().then(sendResponse);
        return true;
      }
      if (message.action === 'restorePage') {
        restoreAll();
        sendResponse({ success: true });
      }
      if (message.action === 'getStatus') {
        sendResponse({
          processed: processedFingerprints.size,
          isProcessing,
          enabled: config?.enabled
        });
      }
    });
  }

  // ============ 初始化 ============
  async function init() {
    console.log('[VocabMeld] Initializing...');

    await loadConfig();
    await loadWordCache();

    
    createTooltip();
    createSelectionPopup();
    
    setupEventListeners();
    
    // 自动处理 - 只有在 API 配置好且开启自动处理时才执行
    if (config.autoProcess && config.enabled && config.apiKey) {
      console.log('[VocabMeld] Auto-processing enabled, starting...');
      setTimeout(() => processPage(), 1000);
    } else {
      console.log('[VocabMeld] Auto-processing disabled or API not configured');
    }
    
    console.log('[VocabMeld] Initialized successfully, config:', {
      autoProcess: config.autoProcess,
      enabled: config.enabled,
      hasApiKey: !!config.apiKey,
      difficultyLevel: config.difficultyLevel
    });
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
