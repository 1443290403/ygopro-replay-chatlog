/* ------------------------------------------------------------------ *
 * 渲染进程和主进程之间那道桥
 *
 * 只开两个口子，都是白名单式的：
 *   invoke(ch, args) —— 渲染进程主动问一次，拿回结果
 *   on(ch, fn)       —— 主进程推过来的事件，返回一个取消订阅的函数
 *
 * **不暴露 ipcRenderer 本身，也不把 event 对象递给回调** —— 那个对象带着
 * sender，等于把「跟主进程任意说话」的完整能力递出去。通道名在 main.js
 * 那边还有一张显式的表，没登记的一律没有 handler，问了就是一句「没有这个接口」。
 * ------------------------------------------------------------------ */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("yrp", {
  invoke: (ch, args) => ipcRenderer.invoke(ch, args),
  on: (ch, fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
});
