(function(root){
  const i18n=typeof module!=='undefined'?require('./i18n.js'):root.LibriumI18n;
  const t=key=>i18n?i18n.t(key):key;
  const fields={host:t('field.host'),path:t('field.path'),url:t('field.url'),method:t('field.method'),status:t('field.status'),type:t('field.type'),body:t('field.body'),header:t('field.header'),frame:t('field.frame'),note:t('field.note'),id:t('field.id'),size:t('field.size')};
  // Bodies are not part of the list rows: the core evaluates these, the page keeps its rows.
  const serverOnly=field=>field==='body'||field==='header'||field==='frame';
  const operators={contains:t('op.contains'),not_contains:t('op.not_contains'),eq:t('op.eq'),ne:t('op.ne'),gte:t('op.gte'),lte:t('op.lte')};
  // Flags reachable as is:error / is:pending in the search box; 1 or 0, never shown in the builder.
  const flags={error:row=>row.error?1:0,pending:row=>row.status==null?1:0,starred:row=>row.starred?1:0,mock:row=>row.mock?1:0};
  // `time` is reached through since:/until: tokens only (milliseconds since the epoch).
  const numeric=field=>['status','id','size','time','elapsed'].includes(field)||field in flags;
  function value(row,field){if(field in flags)return flags[field](row);if(field==='elapsed')return row.elapsed_ms;if(field==='host'||field==='path'){try{const url=new URL(row.url);return field==='host'?url.hostname:url.pathname+url.search;}catch{return '';}}if(field==='type')return row.content_type||'';return row[field];}
  function validate(rule){
    if(!(fields[rule.field]||rule.field in flags||rule.field==='time'||rule.field==='elapsed')||!operators[rule.op])return t('rule.field');
    if(rule.field in flags&&(rule.op!=='eq'||!['0','1'].includes(String(rule.value))))return t('rule.field');
    if(rule.field==='frame'&&!['contains','not_contains'].includes(rule.op))return t('rule.field');
    if(!String(rule.value).trim())return t('rule.value');
    if(numeric(rule.field)&&(!['eq','ne','gte','lte'].includes(rule.op)||!/^\d+$/.test(String(rule.value))))return t('rule.integer');
    if(!numeric(rule.field)&&['gte','lte'].includes(rule.op))return t('rule.textOperator');
    if(rule.field==='status'&&(Number(rule.value)<100||Number(rule.value)>599))return t('rule.statusRange');
    return '';
  }
  function matches(row,rules){return rules.every(rule=>{
    if(validate(rule))return false;
    if(serverOnly(rule.field))return true;
    const original=value(row,rule.field);if(original==null)return false;
    const actual=numeric(rule.field)?Number(original):String(original).toLowerCase();
    const expected=numeric(rule.field)?Number(rule.value):String(rule.value).toLowerCase();
    switch(rule.op){case 'contains':return actual.includes(expected);case 'not_contains':return !actual.includes(expected);case 'eq':return actual===expected;case 'ne':return actual!==expected;case 'gte':return actual>=expected;case 'lte':return actual<=expected;default:return false;}
  });}
  // Sizes in the search box: 500, 20kb, 1.5mb.
  function parseSize(text){const m=/^(\d+(?:\.\d+)?)\s*(b|kb?|mb?|gb?)?$/i.exec(text);if(!m)return null;const unit=(m[2]||'b').toLowerCase()[0];return Math.round(Number(m[1])*({k:1024,m:1048576,g:1073741824}[unit]||1));}
  // The search box understands `field:value` next to free text:
  //   host:api        host contains "api"        host:=api.example.com   exact host
  //   -path:/static   path does not contain      method:post             exact method
  //   status:4xx      any 4xx                    status:>=400 status:<500 status:!=200
  //   size:>1mb id:<=100 type:json               size and id accept > >= < <= != and 1kb/1mb units
  //   "quoted words"  stay together; anything else is searched as text in id, method, URL, status and type.
  const tokenize=input=>String(input||'').match(/(?:[^\s"]+|"[^"]*")+/g)||[];
  function parse(input){
    const rules=[],words=[],conditions=[];
    for(const raw of tokenize(input)){
      const before=rules.length;
      parseToken(raw,rules,words);
      const added=rules.slice(before);
      // A condition the core would refuse (status:99, size:>) is plain text, not a silent no-op chip.
      if(added.some(rule=>validate(rule))){rules.length=before;words.push(raw.replace(/"/g,''));continue;}
      if(added.length)conditions.push({raw,rules:added});
    }
    return {text:words.join(' '),rules,conditions};
  }
  // The search text without one of its conditions, for the chip that removes it.
  function without(input,raw){return tokenize(input).filter(token=>token!==raw).join(' ');}
  // A moment for since:/until:: 10m 2h 1d (ago), 14:30 (today), 2026-09-08 or 2026-09-08 14:30 (local time).
  function parseMoment(text,endOfDay){
    let m;
    if((m=/^(\d+)(s|m|h|d)$/i.exec(text)))return Date.now()-Number(m[1])*{s:1e3,m:6e4,h:36e5,d:864e5}[m[2].toLowerCase()];
    if((m=/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text))){const d=new Date();d.setHours(+m[1],+m[2],+(m[3]||0),0);return d.getTime();}
    if((m=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text))){const dateOnly=m[4]===undefined;const d=new Date(+m[1],+m[2]-1,+m[3],+(m[4]||0),+(m[5]||0),+(m[6]||0),0);return d.getTime()+(dateOnly&&endOfDay?864e5-1:0);}
    return null;
  }
  function parseToken(raw,rules,words){
    {
      const m=/^(-?)([a-z]+):(.*)$/i.exec(raw),field=m&&m[2].toLowerCase();
      const asText=()=>words.push(raw.replace(/"/g,''));
      // A condition still being typed (`host:`, `-status:`, a lone `-`) narrows nothing yet, instead of searching for its own text.
      if(raw==='-'||(m&&!m[3]&&(fields[field]||['is','elapsed','since','until'].includes(field))))return;
      if(m&&field==='is'){const flag=m[3].toLowerCase();if(flag in flags){rules.push({field:flag,op:'eq',value:m[1]==='-'?'0':'1'});return;}asText();return;}
      if(m&&field==='elapsed'){const om=/^(>=|<=|>|<|!=|=)?\s*(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(m[3]);if(!om){asText();return;}let n=Math.round(Number(om[2])*((om[3]||'ms').toLowerCase()==='s'?1000:1));const op=om[1]||'';let rop=op==='>='||op==='>'?'gte':op==='<='||op==='<'?'lte':op==='!='?'ne':'eq';if(op==='>')n+=1;else if(op==='<')n-=1;if(m[1]==='-'){if(rop==='eq')rop='ne';else if(rop==='ne')rop='eq';else if(rop==='gte'){rop='lte';n-=1;}else{rop='gte';n+=1;}}rules.push({field:'elapsed',op:rop,value:String(Math.max(0,n))});return;}
      if(m&&(field==='since'||field==='until')){const at=parseMoment(m[3].replace(/^"|"$/g,''),field==='until');if(at===null||m[1]==='-'){asText();return;}rules.push({field:'time',op:field==='since'?'gte':'lte',value:String(Math.max(0,Math.round(at)))});return;}
      if(!m||!fields[field]||!m[3]){asText();return;}
      const negate=m[1]==='-';let value=m[3].replace(/^"|"$/g,'');
      if(numeric(field)){
        const om=/^(>=|<=|>|<|!=|=)?\s*(.*)$/.exec(value),op=om[1]||'';value=om[2].trim();
        const cls=field==='status'&&!op&&/^([1-5])(xx)?$/i.exec(value);
        if(cls){const from=Number(cls[1])*100;if(negate){asText();return;}rules.push({field,op:'gte',value:String(from)},{field,op:'lte',value:String(from+99)});return;}
        let n=field==='size'?parseSize(value):(/^\d+$/.test(value)?Number(value):null);
        if(n===null){asText();return;}
        let rop=op==='>='||op==='>'?'gte':op==='<='||op==='<'?'lte':op==='!='?'ne':'eq';
        if(op==='>')n+=1;else if(op==='<')n-=1;
        if(negate){if(rop==='eq')rop='ne';else if(rop==='ne')rop='eq';else if(rop==='gte'){rop='lte';n-=1;}else{rop='gte';n+=1;}}
        rules.push({field,op:rop,value:String(Math.max(0,n))});
      }else{
        let op=value.startsWith('=')?'eq':'contains';if(op==='eq')value=value.slice(1);
        if(field==='method')op='eq';
        if(!value){asText();return;}
        if(negate)op=op==='eq'?'ne':'not_contains';
        rules.push({field,op,value});
      }
    }
  }
  const api={fields,operators,numeric,validate,matches,parse,without,label:rule=>`${fields[rule.field]} ${operators[rule.op]} ${rule.value}`};
  if(typeof module!=='undefined')module.exports=api;else root.LibriumFilters=api;
})(globalThis);
