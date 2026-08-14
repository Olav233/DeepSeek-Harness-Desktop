const splashMark = document.querySelector('#splash-mark')
const statusCard = document.querySelector('#status-card')
const title = document.querySelector('#title')
const message = document.querySelector('#message')
const retry = document.querySelector('#retry')
const copy = document.querySelector('#copy')

function setStarting() {
  splashMark.classList.add('is-loading')
  statusCard.hidden = true
}

function setFailure(detail) {
  splashMark.classList.remove('is-loading')
  title.textContent = 'Harness 未能启动'
  message.textContent = detail || '本地运行时没有在预期时间内就绪。'
  statusCard.hidden = false
}

async function start() {
  setStarting()
  const snapshot = await window.desktop.startRuntime()
  if (snapshot.status !== 'ready') setFailure(snapshot.detail)
}

retry.addEventListener('click', () => void start())
copy.addEventListener('click', async () => {
  await window.desktop.copyDiagnostics()
  copy.textContent = '已复制'
  window.setTimeout(() => { copy.textContent = '复制诊断信息' }, 1800)
})

const mode = new URLSearchParams(window.location.search).get('mode')
if (mode === 'renderer-error') {
  setFailure('桌面渲染进程意外结束。请重新启动 Harness。')
}
else if (mode === 'runtime-load-failed') {
  setFailure('Harness 已启动，但页面无法加载。请复制诊断信息后重试。')
}
else if (mode === 'untrusted-runtime') {
  setFailure('拒绝加载未验证的本地运行时地址。')
}
else {
  void start()
}
