// 测试用 MCP server：只读 stdin，从不回包（用于超时/退出清理）。
import readline from 'node:readline';
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', () => {
  // 故意不响应
});
