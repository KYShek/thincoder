import * as readline from "node:readline";

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

let buffer = [];
let promptText = "> ";
process.stdout.write(promptText);

process.stdin.on("keypress", (char, key) => {
  // Ctrl+C 退出
  if (key.ctrl && key.name === "c") {
    process.stdout.write("\n");
    process.exit(0);
  }
  console.log("key", key);
  // Enter / Shift+Enter
  if (key.name === "enter") {
    process.stdout.write("\n");
    if (key.shift) {
      // Shift+Enter：换行
      buffer.push("");
      process.stdout.write(promptText);
    } else {
      // Enter：提交
      const input = buffer.join("");
      console.log("输入内容：", JSON.stringify(input));
      buffer = [];
      process.stdout.write(promptText);
    }
    return;
  }

  // 退格键
  if (key.name === "backspace") {
    if (buffer.length > 0) {
      buffer.pop();
      // 擦除最后一个字符
      process.stdout.write("\b \b");
    }
    return;
  }

  // 普通字符写入缓冲区并回显
  if (char && !key.ctrl) {
    buffer.push(char);
    process.stdout.write(char);
  }
});
