(function(root){
  const i18n=typeof module!=='undefined'?require('./i18n.js'):root.LibriumI18n;
  const filters=typeof module!=='undefined'?require('./filters.js'):root.LibriumFilters;
  const t=key=>i18n?i18n.t(key):key;
  // Suggestions for the search box, the way a query language editor offers them: the fields while a
  // token is being typed, then values once the field has its colon — values seen in the loaded rows
  // first (hosts, paths, methods, statuses, types), then examples of the syntax.
  const FIELDS=['host','path','url','method','status','type','size','elapsed','is','since','until','body','header','frame','note','id'];
  const METHODS=['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'];
  const TYPES=['json','html','xml','text','javascript','css','image','font','audio','video','form','octet-stream'];
  const NUMERIC=['status','size','elapsed','id'];
  const quote=value=>/[\s"]/.test(value)?`"${String(value).replace(/"/g,'')}"`:String(value);
  // The token under the caret: from the previous space (a quoted phrase keeps its spaces) up to the caret.
  function tokenAt(text,caret){
    let start=0,inQuotes=false;
    for(let i=0;i<caret;i++){const c=text[i];if(c==='"')inQuotes=!inQuotes;else if(/\s/.test(c)&&!inQuotes)start=i+1;}
    return {start,text:text.slice(start,caret)};
  }
  // Distinct values of the rows, most frequent first.
  function seen(rows,pick){
    const counts=new Map();
    for(const row of rows){let value;try{value=pick(row);}catch{value=null;}if(value==null||value==='')continue;counts.set(value,(counts.get(value)||0)+1);}
    return [...counts].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0])));
  }
  const hostOf=row=>new URL(row.url).hostname;
  const pathOf=row=>new URL(row.url).pathname;
  const typeOf=row=>{const full=String(row.content_type||'').split(';')[0].trim().toLowerCase();if(!full)return null;return (full.split('/')[1]||full).replace(/^x-/,'').replace(/^vnd\.[^+]*\+/,'');};
  const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  function values(field,partial,rows,negated){
    const items=[];
    const add=(value,hint)=>{if(!items.some(item=>item.value===value))items.push({value,hint:hint||''});};
    const exact=!NUMERIC.includes(field)&&partial.startsWith('=');
    const needle=(exact?partial.slice(1):partial).replace(/^"|"$/g,'').toLowerCase();
    const fromRows=(pick,limit,prefixOnly)=>{
      for(const [value,count] of seen(rows,pick)){
        const text=String(value),lower=text.toLowerCase();
        if(needle&&!(prefixOnly?lower.startsWith(needle):lower.includes(needle)))continue;
        add((exact?'=':'')+quote(text),'× '+count);
        if(items.length>=limit)break;
      }
    };
    const examples=(list,hint)=>{for(const value of list)if(!partial||value.toLowerCase().startsWith(partial.toLowerCase()))add(value,hint);};
    switch(field){
      case 'host':fromRows(hostOf,8,false);break;
      case 'path':fromRows(pathOf,8,false);break;
      case 'method':fromRows(row=>row.method?String(row.method).toUpperCase():null,7,true);examples(METHODS,'');break;
      case 'status':if(!negated)examples(['2xx','3xx','4xx','5xx'],t('suggest.statusClass'));fromRows(row=>row.status,6,true);examples(['>=400','<500','!=200'],t('suggest.compare'));break;
      case 'type':fromRows(typeOf,6,false);examples(TYPES,'');break;
      case 'size':examples(['>1mb','>100kb','<10kb','=0'],t('suggest.sizeUnits'));break;
      case 'id':examples(['>1000','<=100'],t('suggest.compare'));break;
      case 'elapsed':examples(['>1s','>200ms','<100ms'],t('suggest.elapsedUnits'));break;
      case 'is':examples(['error'],t('suggest.errorFlag'));examples(['pending'],t('suggest.pendingFlag'));examples(['starred'],t('suggest.starredFlag'));examples(['mock'],t('suggest.mockFlag'));break;
      case 'since':case 'until':examples(['10m','1h','1d'],t('suggest.ago'));examples(['14:30'],t('suggest.today'));examples([today()],t('suggest.date'));break;
      case 'header':examples(['set-cookie','cache-control','content-encoding','authorization','"content-type: application/json"'],t('suggest.headerExamples'));break;
      default:break; // url and body take free text
    }
    return items.slice(0,10);
  }
  // Host conditions elsewhere in the box narrow the rows the values come from: after `host:=api.example.com`
  // the paths, methods and statuses offered are that host's.
  function narrow(rows,others){
    let rules=[];try{rules=filters.parse(others).rules.filter(rule=>rule.field==='host');}catch{rules=[];}
    if(!rules.length)return rows;
    return rows.filter(row=>{
      let host;try{host=hostOf(row).toLowerCase();}catch{return false;}
      return rules.every(rule=>{const value=String(rule.value).toLowerCase();switch(rule.op){case 'eq':return host===value;case 'ne':return host!==value;case 'contains':return host.includes(value);case 'not_contains':return !host.includes(value);default:return true;}});
    });
  }
  // What to offer for the text with the caret at `caret`; null when there is nothing to say.
  // `start`..`end` is the stretch an accepted item replaces (the token up to the caret).
  function suggest(text,caret,rows){
    const token=tokenAt(String(text||''),Math.max(0,Math.min(caret??0,String(text||'').length)));
    const m=/^(-?)([a-z]*)(:?)([\s\S]*)$/i.exec(token.text);
    if(!m)return null;
    const negate=m[1],name=m[2].toLowerCase(),colon=m[3],rest=m[4];
    if(!colon){
      if(/[^a-z-]/i.test(token.text))return null;
      const list=FIELDS.filter(field=>field.startsWith(name)&&!(negate&&['since','until'].includes(field)));
      if(!list.length)return null;
      return {start:token.start,end:caret,kind:'field',items:list.map(field=>({insert:negate+field+':',label:negate+field+':',hint:t('hint.'+field),keepOpen:true}))};
    }
    if(!FIELDS.includes(name))return null;
    const others=String(text||'').slice(0,token.start)+' '+String(text||'').slice(caret);
    const list=values(name,rest,narrow(rows||[],others),negate==='-');
    if(!list.length)return null;
    return {start:token.start,end:caret,kind:'value',items:list.map(item=>({insert:negate+name+':'+item.value+' ',label:item.value,hint:item.hint,keepOpen:false}))};
  }
  const api={suggest,tokenAt,FIELDS};
  if(typeof module!=='undefined')module.exports=api;else root.LibriumSuggest=api;
})(globalThis);
