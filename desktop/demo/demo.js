/* global document, window */
let state;
let busy = false;
const $ = (id) => document.getElementById(id);
const money = (cents) => cents === null ? "未知" : `¥${(cents / 100).toFixed(2)}`;
function archiveStatusLabel(record) {
  const status = record.task?.status;
  if (!status) return record.action?.statusLabel || '尚未检查';
  const labels = { NOT_CHECKED: '尚未检查', MISSING_DATA: '缺少数据', READY: '已诊断，待预览',
    AWAITING_APPROVAL: record.task.approval ? '已确认，尚未执行' : '等待明确确认',
    EXECUTING: '执行中，结果未确认', SUBMITTED: '已提交，等待回读核对', VERIFYING: '正在核对，尚无结论',
    VERIFIED: '模拟回读一致', PARTIALLY_VERIFIED: '仅部分目标核对一致', FAILED: '未通过核对',
    ROLLED_BACK: '已核实回滚', UNKNOWN: '结果未知，不能判断成功' };
  return `${Object.hasOwn(labels, status) ? labels[status] : '未识别状态，请保留记录'}（${status}）`;
}
function text(id, value) { $(id).textContent = value; }
function renderOpportunities(container,state,busy){
  if(!container||typeof container.replaceChildren!=='function')return;
  const doc=container.ownerDocument||document;
  const sid=state&&state.sessionId!=null?String(state.sessionId):'';
  const open=new Set();
  if(typeof container.querySelectorAll==='function'){
    container.querySelectorAll('details[open]').forEach(function(el){
      const k=el.getAttribute('data-key');
      if(k&&el.getAttribute('data-session')===sid)open.add(k);
    });
  }
  const products=state&&Array.isArray(state.products)?state.products:[];
  const diag=state?state.diagnosis:null;
  const byId=new Map();
  products.forEach(function(p){if(p&&p.id!=null)byId.set(String(p.id),p);});
  const PRI=new Map([['cost','DEMO-002'],['inventory','DEMO-003'],['pricing','DEMO-001']]);
  const DEF=new Map([
    ['cost',{label:'成本资料',next:'本项仅提示补充成本，不提供修改入口。'}],
    ['inventory',{label:'库存资料',next:'先核对实物库存；库存为零不代表已估算缺货损失。可在下方“库存与活动机会”体验独立的库存同步模拟。'}],
    ['pricing',{label:'定价资料',next:'查看依据后，使用下方“查看跟价预览”，再明确确认模拟操作。'}]
  ]);
  const LIMIT='本详情只读，不会执行或自动授权；下方价格、库存与活动模拟流程需要分别预览、明确确认。';
  const num=function(v){return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:'未知';};
  const money=function(v){return num(v)==='未知'?'未知':'¥'+(v/100).toFixed(2);};
  const margin=function(cost,target){
    if(typeof cost!=='number'||!Number.isSafeInteger(cost)||cost<0)return '未知';
    if(typeof target!=='number'||!Number.isSafeInteger(target)||target<=0)return '未知';
    return ((target-cost)/target*100).toFixed(1)+'%';
  };
  const el=function(tag,text){const n=doc.createElement(tag);if(text!=null)n.textContent=String(text);return n;};
  const nodes=[];
  if(!diag||!Array.isArray(diag.priorities)||diag.priorities.length===0){
    nodes.push(el('p','尚未诊断，不能判断门店状态。'));
  }else{
    if(diag.coverage!=null)nodes.push(el('p','覆盖范围：'+diag.coverage));
    diag.priorities.forEach(function(pr,idx){
      if(!pr||typeof pr!=='object')return;
      const pid=typeof pr.id==='string'?pr.id:null;
      const mapped=typeof pr.productId==='string'?pr.productId:(PRI.has(pid)?PRI.get(pid):null);
      const product=mapped?byId.get(mapped)||null:null;
      const def=pid&&DEF.has(pid)?DEF.get(pid):null;
      const key='opp:'+(pid||'unknown')+':'+String(pr.title||idx);
      const det=el('details');
      det.setAttribute('data-key',key);
      det.setAttribute('data-opportunity-id',pid||'unknown');
      det.setAttribute('data-session',sid);
      det.appendChild(el('summary',(pr.title?String(pr.title):(def?def.label:'机会提示'))+(mapped?' ['+mapped+']':'')));
      det.open=open.has(key);
      const add=function(label,val){
        const p=doc.createElement('p');
        p.appendChild(el('strong',label+'：'));
        p.appendChild(el('span',val==null||val===''?'未知':String(val)));
        det.appendChild(p);
      };
      add('依据',pr.reason);
      add('商品',product?(product.name||product.id):'未知');
      add('来源','合成演示数据');
      add('标价',product?money(product.price):'未知');
      add('成本',product?money(product.cost):'未知');
      add('库存',product?num(product.stock):'未知');
      if(pid==='pricing') {
        add('目标价',product?money(product.target):'未知');
        add('预估毛利率',product?margin(product.cost,product.target):'未知');
        add('估算说明','仅按目标价与成本计算，不含其他费用，不等于实际利润；没有外部市场或竞品数据。');
      }
      add('下一步',pid === 'inventory' && !state.task
        ? '先核对实物库存。当前是旧版演示记录；如需体验库存同步，请先处理并保存旧记录，再按页面顶部说明明确复位。'
        : def?def.next:'未提供详细依据，请人工核对。');
      add('限制',LIMIT);
      nodes.push(det);
    });
  }
  nodes.push(el('p','以上为合成演示数据，不调用真实平台接口，也不构成盈利承诺。'));
  container.replaceChildren.apply(container,nodes);
}
function renderSupplemental() {
  const section = $('additional-section');
  section.hidden = !state.diagnosis || !state.task;
  const container = $('additional-opportunities');
  container.replaceChildren();
  if (section.hidden) return;
  for (const [kind, fixture] of Object.entries(state.opportunityCatalog)) {
    const record = state.supplemental?.[kind];
    const task = record?.task;
    const label = kind === 'inventory' ? '库存' : '活动';
    const stateLabel = value => ({ AWAITING_APPROVAL: '等待确认或执行', SUBMITTED: '已提交，待核对',
      UNKNOWN: '结果未知', VERIFIED: '模拟回读一致', FAILED: '模拟目标不一致' }[value] ?? value);
    const valueLabel = value => value === null ? '未知' : kind === 'inventory' ? `${value} 件` : value === 1 ? '已报名' : '未报名';
    const card = document.createElement('article');
    card.dataset.kind = kind;
    const add = (tag, value, parent = card) => {
      const element = document.createElement(tag); element.textContent = value; parent.append(element); return element;
    };
    const send = (operation, extra = {}) => command('opportunity', { kind, operation, ...extra });
    const button = (name, disabled, run, parent = card) => {
      const element = add('button', name, parent); element.disabled = busy || disabled;
      element.addEventListener('click', run); return element;
    };
    add('h3', fixture.title);
    add('p', `建议依据：${fixture.basis}`);
    add('p', `边界：${fixture.limitation}`);
    button(`预览${label}建议`, !!task?.approval, () => send('preview'));
    if (task) {
      add('p', `操作预览：${fixture.title}，${valueLabel(fixture.before)} → ${valueLabel(fixture.value)}。`);
      if (!task.approval) {
        button(`确认${label}预览`, false, () => {
          if (window.confirm(`确认本次${label}模拟？\n${fixture.title}\n${fixture.before} → ${fixture.value} ${fixture.unit}\n${fixture.limitation}`))
            send('confirm', { planId: task.plan.id, confirmed: true });
        });
      } else add('p', '已保存本次模拟确认；重启不会自动执行，此确认不适用于其他任务或真实门店。');
      const cannotWrite = !task.approval || !!task.run;
      button(`执行${label}模拟`, cannotWrite, () => send('execute', { scenario: 'normal' }));
      const advanced = add('details', '');
      add('summary', `${label}异常场景（可选，只能选择一种执行）`, advanced);
      for (const [scenario, name] of [['response_lost', '响应丢失'], ['mismatch', '目标不一致'], ['readback_unavailable', '首次回读不可用']])
        button(`模拟${label}${name}`, cannotWrite, () => send('execute', { scenario }), advanced);
      const canRead = !!task.run && ['SUBMITTED', 'UNKNOWN'].includes(task.status);
      button(`核对${label}模拟结果`, !canRead, () => send('readback'));
      add('p', `任务状态：${stateLabel(task.status)}（${task.status}）；提交次数：${record.submissionCount}。`);
      if (!record.review) add('p', '尚无回读证据，提交不等于成功。');
      else {
        const review = record.review;
        add('p', `复盘：${stateLabel(review.status)}（${review.status}）。${review.items.map(item => `预期 ${valueLabel(item.expected)} / 回读 ${valueLabel(item.observed)}`).join('；')}。实际经营收益：未知。`);
        if (review.status === 'UNKNOWN') add('p', '没有取得目标状态，请再次核对，不要重新执行。');
      }
    }
    container.append(card);
  }
}
function render() {
  text("status", state.message);
  $('legacy-notice').hidden = !state.legacyUpgrade?.available;
  $('upgrade').disabled = busy || !state.legacyUpgrade?.available;
  $('legacy-archive').hidden = !state.legacyArchive;
  const archiveContent = $('legacy-archive-content'); archiveContent.replaceChildren();
  if (state.legacyArchive) {
    const old = state.legacyArchive;
    const rows = [['价格', old], ...Object.entries(old.supplemental || {}).map(([kind, record]) => [kind === 'inventory' ? '库存' : '活动', record])];
    for (const [label, record] of rows) {
      const p = document.createElement('p');
      const status = archiveStatusLabel(record);
      const review = record.review;
      const format = value => value == null ? '未知' : label === '价格' ? money(value) : label === '库存' ? `${value} 件` : value === 1 ? '已报名' : '未报名';
      p.textContent = `${label}旧任务：${status}；提交次数：${record.submissionCount}。${record.task?.approval || record.action ? '旧模拟确认已存档，不授权当前任务。' : '尚无明确确认。'}` + (review
        ? `回读证据：${review.items.map(item => `${item.productId || item.targetId} 预期 ${format(item.expected)} / 回读 ${format(item.observed)}`).join('；')}。`
        : '没有已保存的复盘证据，不能据此判断成功。');
      archiveContent.append(p);
    }
  }
  const diagnosis = $("diagnosis");
  renderOpportunities(diagnosis, state, busy);
  const preview = $("preview-content"); preview.replaceChildren();
  if (!state.preview) preview.textContent = "先完成诊断，再预览具体价格。";
  else {
    const table = document.createElement("table");
    for (const values of [["商品", "原价", "目标价", "成本", "预计毛利率"], ...state.preview.items.map((item) => [item.name, money(item.before), money(item.after), money(item.cost), `${(item.margin * 100).toFixed(1)}%`])]) {
      const row = document.createElement("tr");
      for (const value of values) { const cell = document.createElement(table.rows.length ? "td" : "th"); cell.textContent = value; row.append(cell); }
      table.append(row);
    }
    preview.append(table);
    const note = document.createElement("p"); note.textContent = `最低毛利率 20%；${state.preview.excluded.length} 个缺成本或不满足毛利要求的候选被排除。预计毛利不等于实际经营收益。`; preview.append(note);
  }
  text("action-state", state.action ? `模拟动作：${state.action.statusLabel}；提交次数：${state.submissionCount}` : "尚未确认。");
  if (state.task && state.action) {
    const labels = { AWAITING_APPROVAL: '已保存确认，尚未执行', SUBMITTED: '已提交，待核对',
      UNKNOWN: '结果未知', VERIFIED: '模拟回读一致', FAILED: '模拟目标不一致', PARTIALLY_VERIFIED: '仅部分目标一致' };
    text('action-state', `模拟任务：${labels[state.task.status] || state.task.status}（${state.task.status}）；提交次数：${state.submissionCount}`);
  }
  const unavailable = state.readbackAttempts?.at(-1)?.status === 'UNKNOWN';
  if (unavailable) text('action-state', `模拟结果：未知（UNKNOWN）；提交次数：${state.submissionCount}。没有取得回读证据，不能判断成功或失败。`);
  text("review", state.review ? `${state.review.matchedCount}/${state.review.items.length} 项模拟回读一致。${state.review.items.map((item) => `${item.productId}：预期 ${money(item.expected)} / 回读 ${money(item.observed)}`).join("；")}。实际利润效果：未知。本结果不代表真实平台验证。` : "提交不等于成功，必须逐项核对。");
  $("diagnose").disabled = busy || !!state.action;
  $("preview").disabled = busy || !state.diagnosis || !!state.action;
  $("consent").disabled = busy || !state.preview || !!state.action;
  // Show persisted authorization as a record, never as a newly checked consent.
  $("consent-choice").hidden = !!state.action;
  $("authorization-record").hidden = !state.action;
  text('authorization-record', state.action ? '已保存本次预览的模拟确认。此记录仅适用于当前预览；恢复界面不会自动执行，也不授权任何真实门店操作。' : '');
  $("confirm").hidden = !!state.action;
  $("confirm").disabled = busy || !state.preview || !!state.action || !$("consent").checked;
  $("execute").disabled = busy || (state.task
    ? state.task.status !== 'AWAITING_APPROVAL' || !state.task.approval || !!state.task.run
    : state.action?.status !== "pending");
  $("scenario").disabled = busy || !!state.submissionCount;
  if (state.submissionCount) $("scenario").value = state.executionScenario || 'unknown';
  $("readback").disabled = busy || (state.task
    ? !['SUBMITTED', 'UNKNOWN'].includes(state.task.status) || !state.task.run
    : state.action?.status !== "awaiting_readback");
  $("readback").textContent = unavailable ? '再次核对（不重复提交）' : '核对模拟平台结果';
  if (unavailable) text('review', '模拟平台暂时无法回读；尚无可核实的目标价格。请再次核对，不要重新执行。');
  $("reset").disabled = busy;
  renderSupplemental();
  $('recover').hidden = !state.recovery?.required;
  $('recover').disabled = true;
  if (state.recovery?.required) {
    text('status', state.recovery.message);
    document.querySelectorAll('button, input, select').forEach(element => { element.disabled = true; });
    $('recover').disabled = busy || state.recovery.canRecover !== true;
  }
}
async function command(name, input) {
  if (busy) return;
  busy = true; if (state) render();
  try {
    state = await window.opspilotDemo.command(name, input);
    if (["reset", "preview", "upgrade"].includes(name)) $("consent").checked = false;
    if (['reset', 'upgrade'].includes(name)) $("scenario").value = 'normal';
  } catch (error) {
    // A failed async command may already have persisted UNKNOWN. Refresh the
    // read-only snapshot instead of leaving the previous approval on screen.
    try { state = await window.opspilotDemo.command('snapshot'); } catch { /* Preserve last known view, never invent success. */ }
    busy = false; if (state) render(); text("status", `操作未完成：${error.message}`); return;
  }
  busy = false; render();
}
$("consent").addEventListener("change", render);
for (const name of ["diagnose", "preview", "readback", "recover", "upgrade"]) $(name).addEventListener("click", () => command(name));
$("confirm").addEventListener("click", () => command("confirm", { previewId: state.preview?.id, confirmed: $("consent").checked }));
$("execute").addEventListener("click", () => command("execute", { scenario: $("scenario").value }));
$("reset").addEventListener("click", () => { if (window.confirm("复位将清除本次模拟记录，不影响真实门店。继续吗？")) command("reset", { confirmed: true }); });
command("snapshot");
