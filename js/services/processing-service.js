/**
 * VocabMeld 处理服务模块
 * 协调页面处理流程
 */

import { contentSegmenter } from './content-segmenter.js';
import { textReplacer } from './text-replacer.js';
import { apiService } from './api-service.js';
import { storage } from '../core/storage.js';

/**
 * 处理服务类
 */
class ProcessingService {
  constructor() {
    this.isProcessing = false;
    this.processingQueue = [];
    this.observer = null;
    this.scrollHandler = null;
    this.debounceTimer = null;
    this.config = null;
  }

  /**
   * 初始化服务
   * @returns {Promise<void>}
   */
  async init() {
    this.config = await storage.getConfig();
    
    // 设置滚动监听
    this.setupScrollListener();
    
    // 设置 DOM 变化监听
    this.setupMutationObserver();
    
    console.log('[VocabMeld] Processing service initialized');
  }

  /**
   * 设置滚动监听（懒加载）
   */
  setupScrollListener() {
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
    }

    this.scrollHandler = this.debounce(() => {
      if (this.config?.autoProcess && this.config?.enabled) {
        this.processViewport();
      }
    }, 500);

    window.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  /**
   * 设置 DOM 变化监听
   */
  setupMutationObserver() {
    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver(
      this.debounce((mutations) => {
        if (!this.config?.autoProcess || !this.config?.enabled) return;

        // 检查是否有新增的文本内容
        const hasNewContent = mutations.some(mutation => {
          return mutation.addedNodes.length > 0 && 
                 Array.from(mutation.addedNodes).some(node => 
                   node.nodeType === Node.ELEMENT_NODE && 
                   node.textContent?.trim().length > 50
                 );
        });

        if (hasNewContent) {
          this.processViewport();
        }
      }, 1000)
    );

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /**
   * 防抖函数
   * @param {Function} func - 要执行的函数
   * @param {number} wait - 等待时间
   * @returns {Function}
   */
  debounce(func, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  /**
   * 处理当前页面
   * @param {object} options - 选项
   * @returns {Promise<{ processed: number, errors: number }>}
   */
  async processPage(options = {}) {
    if (this.isProcessing) {
      console.log('[VocabMeld] Already processing, skipping...');
      return { processed: 0, errors: 0, skipped: true };
    }

    this.isProcessing = true;
    let processed = 0;
    let errors = 0;

    try {
      // 重新加载配置
      this.config = await storage.getConfig();
      
      if (!this.config.enabled) {
        return { processed: 0, errors: 0, disabled: true };
      }

      // 检查站点黑名单
      const hostname = window.location.hostname;
      if (await storage.isBlacklisted(hostname)) {
        console.log('[VocabMeld] Site is blacklisted:', hostname);
        return { processed: 0, errors: 0, blacklisted: true };
      }

      // 获取页面分段
      const segments = options.viewportOnly 
        ? contentSegmenter.getViewportSegments()
        : contentSegmenter.getPageSegments();

      console.log(`[VocabMeld] Found ${segments.length} segments to process`);

      // 获取白名单（已学会的词汇）
      const whitelist = await storage.getWhitelist();
      const whitelistWords = new Set(whitelist.map(w => w.original.toLowerCase()));

      // 处理每个分段
      for (const segment of segments) {
        try {
          // 过滤掉白名单词汇
          let text = segment.text;
          for (const word of whitelistWords) {
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            text = text.replace(regex, '');
          }

          if (text.trim().length < 30) continue;

          // 调用 API 获取翻译
          const replacements = await apiService.translate(text);

          if (replacements && replacements.length > 0) {
            // 过滤白名单词汇
            const filtered = replacements.filter(
              r => !whitelistWords.has(r.original.toLowerCase())
            );

            // 应用替换
            const count = textReplacer.applyReplacements(segment.element, filtered);
            processed += count;

            // 标记分段为已处理
            contentSegmenter.markProcessed(segment.fingerprint);
          }
        } catch (error) {
          console.error('[VocabMeld] Segment processing error:', error);
          errors++;
        }
      }

      console.log(`[VocabMeld] Processed ${processed} words with ${errors} errors`);
      return { processed, errors };

    } catch (error) {
      console.error('[VocabMeld] Page processing error:', error);
      return { processed, errors: errors + 1, error: error.message };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 处理视口内容
   * @returns {Promise<object>}
   */
  async processViewport() {
    return this.processPage({ viewportOnly: true });
  }

  /**
   * 恢复页面
   */
  restorePage() {
    textReplacer.restoreAll();
    contentSegmenter.clearProcessed();
    console.log('[VocabMeld] Page restored');
  }

  /**
   * 更新配置
   * @param {object} newConfig - 新配置
   */
  async updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * 销毁服务
   */
  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }

    this.restorePage();
    console.log('[VocabMeld] Processing service destroyed');
  }
}

// 导出单例
export const processingService = new ProcessingService();
export default processingService;

