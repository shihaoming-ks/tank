# ABI 兼容性速查

## 目标机检查命令

```bash
# 1. CPU 架构
uname -m
# x86_64 → linux-x64 或 linux-x64-glibc-217
# aarch64 → linux-arm64

# 2. glibc 版本
ldd --version | head -1
# glibc < 2.28 且 x86_64 → 必须用 linux-x64-glibc-217

# 3. GLIBCXX 版本（可选，更细粒度）
strings /usr/lib64/libstdc++.so.6 2>/dev/null | grep -oE 'GLIBCXX_[0-9.]+' | sort -V | tail -3
```

## 二进制 ABI 要求读取

```bash
# 读取打包后 Node 二进制的实际 ABI 要求
NODE_BIN="runtime/bin/node"
strings "$NODE_BIN" | grep -oE 'GLIBC_[0-9.]+' | sort -uV | tail -3
strings "$NODE_BIN" | grep -oE 'GLIBCXX_[0-9.]+' | sort -uV | tail -3
strings "$NODE_BIN" | grep -oE 'CXXABI_[0-9.]+' | sort -uV | tail -3
```

## 已验证的目标对照

| TARGET | Node 版本 | 最低 glibc | 最低 GLIBCXX | 测试系统 |
|--------|-----------|-----------|-------------|---------|
| `linux-x64` | v22.20.0 | 2.28 | 3.4.21 | Ubuntu 22.04 |
| `linux-x64-glibc-217` | v22.20.0 | **2.17** | **3.4.19** | CentOS 7.9 |
| `linux-arm64` | v22.20.0 | 2.28 | 3.4.21 | Debian 12 ARM |

## 常见错误速查

| 错误信息 | 原因 | 解决 |
|---------|------|------|
| `version 'GLIBC_2.28' not found` | 使用了标准包，但 glibc 太旧 | 改用 `linux-x64-glibc-217` |
| `version 'GLIBCXX_3.4.21' not found` | libstdc++ 版本过低 | 同上 |
| `Exec format error` | CPU 架构不匹配 | `uname -m` 确认后选对 TARGET |
| `xz: Unexpected end of input` | 下载不完整 | 脚本自动删除缓存并重试 |
