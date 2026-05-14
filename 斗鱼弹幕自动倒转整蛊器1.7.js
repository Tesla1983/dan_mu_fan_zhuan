// ==UserScript==
// @name         斗鱼弹幕自动倒转
// @namespace    tampermonkey.net
// @version      1.7
// @description  在斗鱼输入框打字输入并发送时，自动将汉字顺序倒转发送
// @author
// @match			*://*.douyu.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  // ==================== 调试开关 ====================
  const DEBUG = false;
  const log = DEBUG ? console.log.bind(console, "【倒转】") : function () {};

  // ==================== 开关状态管理 ====================
  const STORAGE_KEY = "douyu_reverse_enabled";
  let reverseEnabled = true;

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) reverseEnabled = saved === "true";
  } catch (e) {}

  function saveEnabledState() {
    try {
      localStorage.setItem(STORAGE_KEY, reverseEnabled);
    } catch (e) {}
  }

  // 跨标签页同步开关状态
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY && e.newValue !== null) {
      reverseEnabled = e.newValue === "true";
      if (currentButton) {
        updateButtonUI(currentButton);
      }
    }
  });

  // ==================== 注入 CSS 样式（一次性） ====================
  const STYLE_ID = "douyu-reverse-style";
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .ChatToolBar__right .custom-reverse-toggle {
        position: relative;
        display: inline-flex;
        vertical-align: middle;
        width: 30px;
        height: 18px;
        box-sizing: border-box;
        cursor: pointer;
        margin-right: 8px;
        align-items: center;
        justify-content: center;
        line-height: normal;
        font-size: 12px;
        border-radius: 3px;
        font-weight: bold;
        user-select: none;
        z-index: 1000;
        transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      }
      .custom-reverse-toggle.on {
        background-color: #ff8c00;
        color: #fff;
        border-color: #ff8c00;
        box-shadow: 0 0 4px rgba(255, 140, 0, 0.5);
      }
      .custom-reverse-toggle.off {
        background-color: rgba(128, 128, 128, 0.15);
        color: #666;
        border-color: rgba(128, 128, 128, 0.3);
        box-shadow: none;
      }
      .custom-reverse-toggle:hover {
        background-color: #ff5d23;
        border-color: #ff5d23;
        box-shadow: 0 0 8px rgba(255, 93, 35, 0.8);
      }
    `;
    document.head.appendChild(style);
  }

  function updateButtonUI(btn) {
    if (!btn) return;
    if (reverseEnabled) {
      btn.classList.add("on");
      btn.classList.remove("off");
      btn.title = "点击关闭弹幕倒转";
    } else {
      btn.classList.add("off");
      btn.classList.remove("on");
      btn.title = "点击开启弹幕倒转";
    }
  }

  // ==================== 倒转核心 ====================
  function reverseString(str) {
    // 使用 Intl.Segmenter 正确处理 Emoji 和 ZWJ 序列
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      try {
        const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        return Array.from(segmenter.segment(str)).reverse().map(seg => seg.segment).join("");
      } catch (e) {}
    }
    // 兜底方案：[...str] 对大多数字符有效
    return [...str].reverse().join("");
  }

  function triggerInputEvent(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ==================== 注入开关按钮（带防消失机制） ====================
  let currentButton = null;

  function injectToggleButton() {
    const toolBarRight = document.querySelector(".ChatToolBar__right");
    if (!toolBarRight) return false;

    // 如果按钮已存在且还在DOM中，直接返回
    if (currentButton && document.body.contains(currentButton)) {
      return true;
    }

    // 移除旧的可能残留的按钮
    if (currentButton && currentButton.parentNode) currentButton.remove();

    // 创建新按钮
    const toggleBtn = document.createElement("div");
    toggleBtn.className = "custom-reverse-toggle";
    toggleBtn.textContent = "倒";

    // 初始化按钮UI状态
    updateButtonUI(toggleBtn);

    // 点击事件
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      reverseEnabled = !reverseEnabled;
      saveEnabledState();
      updateButtonUI(toggleBtn);
      log(`开关已${reverseEnabled ? "开启" : "关闭"}`);
    });

    // 插入到工具栏右侧区域的最前面
    toolBarRight.insertBefore(toggleBtn, toolBarRight.firstChild);
    currentButton = toggleBtn;
    return true;
  }

  // 监听工具栏变化，若按钮被删除则重新注入
  function watchToolbar() {
    const toolbar = document.querySelector(".ChatToolBar__right");
    if (!toolbar) return;
    const observer = new MutationObserver(() => {
      if (currentButton && !document.body.contains(currentButton)) {
        log("检测到按钮被移除，重新注入");
        injectToggleButton();
      }
    });
    observer.observe(toolbar, { childList: true, subtree: false });
  }

  // ==================== 劫持聊天逻辑 ====================
  let isProcessing = false; // 防止递归触发
  let isComposing = false; // 输入法编辑阶段标志

  function hookChat() {
    const inputBox = document.querySelector(".ChatSend-txt");
    const sendBtn = document.querySelector(".ChatSend-button");
    if (!inputBox || !sendBtn) return false;
    if (inputBox.hasAttribute("data-reverse-hooked")) return true;

    inputBox.setAttribute("data-reverse-hooked", "true");
    log("已劫持聊天（支持开关）");

    // 监听输入法编辑状态
    inputBox.addEventListener("compositionstart", () => {
      isComposing = true;
    });
    inputBox.addEventListener("compositionend", () => {
      isComposing = false;
    });

    /**
     * 统一发送逻辑：
     * 1. 根据开关决定是否倒转文字
     * 2. 填入倒转后的文字并触发 input 事件
     * 3. 模拟点击发送按钮
     * 4. 发送后清空输入框（通过 MutationObserver 检测）
     */
    function doSend() {
      if (isProcessing || isComposing) return;
      if (inputBox.hasAttribute("disabled") || inputBox.hasAttribute("readonly")) return;
      const originalText = inputBox.textContent.trim();
      if (!originalText) return;

      isProcessing = true;
      const textToSend = reverseEnabled ? reverseString(originalText) : originalText;
      inputBox.textContent = textToSend;
      triggerInputEvent(inputBox);

      // 用一次性 observer 监听输入框被清空（斗鱼发送成功后会清空）
      const clearObserver = new MutationObserver(() => {
        if (!inputBox.textContent) {
          clearObserver.disconnect();
          isProcessing = false;
        }
      });
      // 仅监听文本内容变化，不监听子树变化避免过敏感
      clearObserver.observe(inputBox, { characterData: true, subtree: false, childList: false });

      // 兜底：300ms 后强制释放锁并清空输入框
      setTimeout(() => {
        clearObserver.disconnect();
        if (inputBox.textContent === textToSend) {
          inputBox.textContent = "";
          triggerInputEvent(inputBox);
        }
        isProcessing = false;
      }, 300);

      sendBtn.click();
    }

    // 拦截回车
    inputBox.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        doSend();
      }
    });

    // 拦截发送按钮点击（捕获阶段）
    sendBtn.addEventListener(
      "mousedown",
      function (e) {
        if (isProcessing) return; // 由 doSend 内部模拟的 click 跳过
        e.preventDefault();
        e.stopPropagation();
        doSend();
      },
      true,
    );

    return true;
  }

  // ==================== 初始化（持续监测页面变化） ====================
  function init() {
    injectStyles();
    injectToggleButton();
    watchToolbar();
    hookChat();
  }

  // 监听动态加载（房间切换、工具栏重新渲染等）- 使用 requestAnimationFrame 节流
  let ticking = false;
  let initFailCount = 0;

  const globalObserver = new MutationObserver(() => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const hasInput = document.querySelector(".ChatSend-txt");
        const hasSendBtn = document.querySelector(".ChatSend-button");
        const hasToolbar = document.querySelector(".ChatToolBar__right");
        if (hasInput && hasSendBtn && hasToolbar) {
          initFailCount = 0;
          init();
        } else {
          initFailCount++;
          if (initFailCount > 10) {
            log("警告：找不到聊天框，脚本可能失效（斗鱼页面结构已变更）");
            initFailCount = 0;
          }
        }
      });
    }
  });
  globalObserver.observe(document.body, { childList: true, subtree: true, attributes: false, characterData: false });

  // 页面隐藏时暂停监听，显示时恢复（节省资源）
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      globalObserver.disconnect();
      log("页面隐藏，暂停监听");
    } else {
      globalObserver.observe(document.body, { childList: true, subtree: true, attributes: false, characterData: false });
      log("页面显示，恢复监听");
    }
  });

  // 在 DOM 就绪后尽快初始化，同时保留 MutationObserver 兜底 SPA 导航
  function tryInit() {
    if (document.querySelector(".ChatSend-txt")) {
      init();
      return true;
    }
    return false;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      tryInit();
    });
  } else {
    tryInit();
  }
})();
