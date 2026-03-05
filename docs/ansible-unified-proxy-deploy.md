# Ansible 部署：unified-proxy OCI VM

## 概述

将 `unified-proxy` 以裸机 Node.js + systemd 方式部署到 OCI VM，Caddy 做 TLS 终结。

**源码获取方式：** 在远端主机直接 `git clone` mentor-agent 仓库，从中提取 `unified-proxy/` 目录。
**敏感数据（auth.json、API key）：** 全部通过 ansible-vault 加密变量管理，无需手动复制文件。

**部署产物：**
- `/opt/unified-proxy/server.js` — 代理主程序（来自 git）
- `/opt/unified-proxy/package.json`（来自 git）
- `/opt/unified-proxy/auth.json` — OAuth tokens（来自 vault，600 权限）
- `/opt/unified-proxy/.env` — 运行时环境变量（来自 vault + template，600 权限）
- `/etc/systemd/system/unified-proxy.service`
- `/etc/caddy/Caddyfile`

---

## 目录结构（放入你的 IaC 项目）

```
ansible/
├── inventory/
│   └── hosts.yml
├── group_vars/
│   └── proxy/
│       ├── vars.yml
│       └── vault.yml          # ansible-vault 加密，包含所有敏感变量
├── templates/
│   ├── env.j2
│   └── Caddyfile.j2
├── handlers/
│   └── main.yml
└── deploy-unified-proxy.yml   # 主 playbook
```

> `files/` 目录不再需要，源码和敏感数据都在远端解决。

---

## 1. Inventory — `inventory/hosts.yml`

```yaml
all:
  children:
    proxy:
      hosts:
        oci-proxy:
          ansible_host: YOUR_OCI_VM_IP
          ansible_user: ubuntu
          ansible_ssh_private_key_file: ~/.ssh/your-oci-key.pem
```

---

## 2. 变量 — `group_vars/proxy/vars.yml`

```yaml
# ── 源码仓库（独立 repo）──
repo_url: "https://github.com/your-org/unified-proxy.git"
repo_version: "main"                        # branch / tag / commit SHA
repo_clone_dir: "/tmp/unified-proxy-deploy" # 临时克隆目录，部署后可清理

# ── 部署路径 ──
proxy_install_dir: /opt/unified-proxy

# ── 服务绑定（Caddy 在外层做 TLS，这里绑定 loopback）──
proxy_host: "127.0.0.1"
proxy_port: 3456

# ── 子域名（需提前将 DNS 解析到 OCI VM 公网 IP）──
proxy_domain: proxy.yourdomain.com

# ── Node.js 版本 ──
nodejs_major: 20
```

---

## 3. 敏感变量 — `group_vars/proxy/vault.yml`

> 先编辑填入真实值，再执行 `ansible-vault encrypt group_vars/proxy/vault.yml`。

```yaml
# ── API Key（openssl rand -hex 32 生成）──
vault_proxy_api_key: "your-random-64-char-hex-key"

# ── OAuth Token 文件内容（从本地 ~/.unified-proxy/auth.json 粘贴）──
# 格式：双 section JSON，包含 anthropic + openai 两组 token
vault_auth_json: |
  {
    "anthropic": {
      "accessToken": "sk-ant-...",
      "refreshToken": "...",
      "expiresAt": 1234567890000
    },
    "openai": {
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": 1234567890000,
      "accountId": "user-..."
    }
  }
```

---

## 4. 模板 — `templates/env.j2`

```jinja2
HOST={{ proxy_host }}
PORT={{ proxy_port }}
PROXY_AUTH_FILE={{ proxy_install_dir }}/auth.json
PROXY_API_KEY={{ vault_proxy_api_key }}
```

---

## 5. 模板 — `templates/Caddyfile.j2`

```jinja2
{{ proxy_domain }} {
    reverse_proxy localhost:{{ proxy_port }}

    header {
        X-Frame-Options DENY
        X-Content-Type-Options nosniff
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }
}
```

---

## 6. Handlers — `handlers/main.yml`

```yaml
- name: reload systemd
  systemd:
    daemon_reload: true

- name: restart unified-proxy
  systemd:
    name: unified-proxy
    state: restarted

- name: restart caddy
  systemd:
    name: caddy
    state: restarted
```

---

## 7. 主 Playbook — `deploy-unified-proxy.yml`

```yaml
---
- name: Deploy unified-proxy to OCI VM
  hosts: proxy
  become: true
  # vars_files 不需要：Ansible 会根据主机组自动加载 group_vars/proxy/ 下的所有文件
  # （包括 vault.yml，运行时传 --ask-vault-pass 即可）

  handlers:
    - import_tasks: handlers/main.yml

  tasks:

    # ── 1. 系统依赖 ────────────────────────────────────────────────

    - name: Install prerequisite packages
      apt:
        name:
          - curl
          - ca-certificates
          - gnupg
          - git
          - debian-keyring
          - debian-archive-keyring
          - apt-transport-https
          - python3
          - netfilter-persistent
          - iptables-persistent
        state: present
        update_cache: true

    - name: Add NodeSource GPG key
      shell: |
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
          | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
      args:
        creates: /usr/share/keyrings/nodesource.gpg

    - name: Add NodeSource apt repository
      apt_repository:
        repo: "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_{{ nodejs_major }}.x nodistro main"
        filename: nodesource
        state: present

    - name: Install Node.js {{ nodejs_major }}
      apt:
        name: nodejs
        state: present
        update_cache: true

    - name: Add Caddy GPG key
      shell: |
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
          | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      args:
        creates: /usr/share/keyrings/caddy-stable-archive-keyring.gpg

    - name: Add Caddy apt repository
      shell: |
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
          > /etc/apt/sources.list.d/caddy-stable.list
      args:
        creates: /etc/apt/sources.list.d/caddy-stable.list

    - name: Install Caddy
      apt:
        name: caddy
        state: present
        update_cache: true

    # ── 2. 防火墙 ──────────────────────────────────────────────────
    # OCI 安全列表需在控制台手动开放 TCP 80/443（见文末说明）
    # 以下规则处理 VM 内的 iptables

    - name: Allow HTTP (80) through iptables
      iptables:
        chain: INPUT
        protocol: tcp
        destination_port: "80"
        jump: ACCEPT
        state: present

    - name: Allow HTTPS (443) through iptables
      iptables:
        chain: INPUT
        protocol: tcp
        destination_port: "443"
        jump: ACCEPT
        state: present

    - name: Persist iptables rules
      command: netfilter-persistent save
      changed_when: false

    # ── 3. 源码部署（git clone → 提取 unified-proxy/）─────────────

    - name: Create install directory
      file:
        path: "{{ proxy_install_dir }}"
        state: directory
        owner: ubuntu
        group: ubuntu
        mode: "0755"

    - name: Clone / update unified-proxy repository
      git:
        repo: "{{ repo_url }}"
        dest: "{{ repo_clone_dir }}"
        version: "{{ repo_version }}"
        depth: 1
        force: true
      become_user: ubuntu
      tags: [code]

    - name: Copy server.js from repo
      copy:
        src: "{{ repo_clone_dir }}/server.js"
        dest: "{{ proxy_install_dir }}/server.js"
        remote_src: true
        owner: ubuntu
        group: ubuntu
        mode: "0644"
      notify: restart unified-proxy
      tags: [code]

    - name: Copy package.json from repo
      copy:
        src: "{{ repo_clone_dir }}/package.json"
        dest: "{{ proxy_install_dir }}/package.json"
        remote_src: true
        owner: ubuntu
        group: ubuntu
        mode: "0644"
      tags: [code]

    # 注意：package.json 的 dependencies 为空，无需执行 npm install

    - name: Clean up temporary clone directory
      file:
        path: "{{ repo_clone_dir }}"
        state: absent

    # ── 4. 敏感数据（来自 vault）──────────────────────────────────

    - name: Deploy auth.json from vault
      copy:
        content: "{{ vault_auth_json }}"
        dest: "{{ proxy_install_dir }}/auth.json"
        owner: ubuntu
        group: ubuntu
        mode: "0600"
      tags: [auth]
      notify: restart unified-proxy

    - name: Deploy .env from template
      template:
        src: templates/env.j2
        dest: "{{ proxy_install_dir }}/.env"
        owner: ubuntu
        group: ubuntu
        mode: "0600"
      notify: restart unified-proxy

    # ── 5. systemd 服务 ────────────────────────────────────────────

    - name: Deploy systemd service unit
      copy:
        content: |
          [Unit]
          Description=Unified Proxy - Multi-Provider OAuth Proxy (Anthropic + OpenAI)
          After=network-online.target
          Wants=network-online.target

          [Service]
          Type=simple
          User=ubuntu
          Group=ubuntu
          WorkingDirectory={{ proxy_install_dir }}
          ExecStart=/usr/bin/node {{ proxy_install_dir }}/server.js
          EnvironmentFile={{ proxy_install_dir }}/.env
          Restart=always
          RestartSec=5
          StartLimitInterval=60s
          StartLimitBurst=5
          NoNewPrivileges=true
          PrivateTmp=true
          ProtectSystem=strict
          ReadWritePaths={{ proxy_install_dir }}
          LimitNOFILE=65536
          KillMode=mixed
          KillSignal=SIGTERM
          TimeoutStopSec=10s
          StandardOutput=journal
          StandardError=journal
          SyslogIdentifier=unified-proxy

          [Install]
          WantedBy=multi-user.target
        dest: /etc/systemd/system/unified-proxy.service
        mode: "0644"
      notify:
        - reload systemd
        - restart unified-proxy

    - name: Enable and start unified-proxy
      systemd:
        name: unified-proxy
        enabled: true
        state: started
        daemon_reload: true

    # ── 6. Caddy 配置 ──────────────────────────────────────────────

    - name: Deploy Caddyfile
      template:
        src: templates/Caddyfile.j2
        dest: /etc/caddy/Caddyfile
        mode: "0644"
      notify: restart caddy

    - name: Enable and start Caddy
      systemd:
        name: caddy
        enabled: true
        state: started

    # ── 7. 验证 ────────────────────────────────────────────────────

    - name: Wait for unified-proxy to be ready
      wait_for:
        host: "127.0.0.1"
        port: "{{ proxy_port }}"
        timeout: 15

    - name: Health check (local, no auth required)
      uri:
        url: "http://127.0.0.1:{{ proxy_port }}/health"
        method: GET
        status_code: 200
        return_content: true
      register: health
      changed_when: false

    - name: Print health check result
      debug:
        msg: "{{ health.json }}"
```

---

## 8. 首次部署步骤

```bash
# 1. 获取本地 auth.json 内容，填入 vault.yml 的 vault_auth_json 字段
cat ~/.unified-proxy/auth.json

# 2. 编辑并加密 vault.yml
ansible-vault edit group_vars/proxy/vault.yml   # 填入 vault_proxy_api_key 和 vault_auth_json

# 3. 填写 vars.yml 中的 repo_url 和 proxy_domain

# 4. 检查连通性
ansible proxy -m ping -i inventory/hosts.yml

# 5. 预览变更（dry-run）
ansible-playbook deploy-unified-proxy.yml -i inventory/hosts.yml \
  --ask-vault-pass --check

# 6. 正式部署
ansible-playbook deploy-unified-proxy.yml -i inventory/hosts.yml \
  --ask-vault-pass
```

---

## 9. 部署后验证

```bash
PROXY_DOMAIN="proxy.yourdomain.com"
PROXY_API_KEY="your-generated-key"

# 健康检查（无需 key）
curl -s https://${PROXY_DOMAIN}/health | python3 -m json.tool

# 无 key → 应返回 401
curl -s https://${PROXY_DOMAIN}/v1/models

# 带 key → 返回模型列表
curl -s https://${PROXY_DOMAIN}/v1/models \
  -H "Authorization: Bearer ${PROXY_API_KEY}"

# Anthropic 推理测试
curl -s https://${PROXY_DOMAIN}/v1/chat/completions \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4","messages":[{"role":"user","content":"Reply: PROXY_OK"}],"stream":false}' \
  | python3 -m json.tool

# OpenAI 推理测试
curl -s https://${PROXY_DOMAIN}/v1/chat/completions \
  -H "Authorization: Bearer ${PROXY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"Reply: PROXY_OK"}],"stream":false}' \
  | python3 -m json.tool
```

---

## 10. Token 过期后的更新流程

OAuth token 在本地 Mac 重新登录后，只需更新 vault 并重推：

```bash
# 1. Mac 本地重新登录
cd /path/to/mentor-agent/unified-proxy
node server.js --login all

# 2. 更新 vault.yml 中的 vault_auth_json
cat ~/.unified-proxy/auth.json   # 复制内容
ansible-vault edit group_vars/proxy/vault.yml

# 3. 仅推送 auth.json（--tags auth，不重跑全量）
ansible-playbook deploy-unified-proxy.yml -i inventory/hosts.yml \
  --ask-vault-pass --tags auth
```

---

## 11. 代码更新流程

当 `server.js` 有新版本时，仅重跑代码部分：

```bash
ansible-playbook deploy-unified-proxy.yml -i inventory/hosts.yml \
  --ask-vault-pass --tags code
```

> `Clone / update`、`Copy server.js`、`Copy package.json` 三个 task 均已标注 `tags: [code]`，开箱即用。

---

## 12. OCI 控制台手动操作（Ansible 无法自动完成）

在 OCI 控制台 → **Networking → VCN → Security Lists → Ingress Rules** 添加：

| 协议 | 源 CIDR    | 目标端口 | 说明 |
|------|------------|---------|------|
| TCP  | 0.0.0.0/0 | 80      | HTTP（Let's Encrypt 验证）|
| TCP  | 0.0.0.0/0 | 443     | HTTPS |
