(function(root){
  const fields={host:'Хост',path:'Путь',url:'URL',method:'Метод',status:'Статус',id:'ID',size:'Размер (байт)',capture_target:'Окно / поток'};
  const operators={contains:'содержит',not_contains:'не содержит',eq:'равно',ne:'не равно',gte:'≥',lte:'≤'};
  const numeric=field=>['status','id','size'].includes(field);
  const statusText=row=>row.status==null?(row.error?'Нет ответа':'Ожидание'):String(row.status);
  function statusMatches(row,status){if(!status)return true;if(status==='pending')return row.status==null&&!row.error;if(status==='error')return Boolean(row.error);return ['1','2','3','4','5'].includes(status)&&row.status!=null&&String(row.status).startsWith(status);}
  function value(row,field){if(field==='host'||field==='path'){try{const url=new URL(row.url);return field==='host'?url.hostname:url.pathname+url.search;}catch{return '';}}return row[field];}
  function validate(rule){
    if(!fields[rule.field]||!operators[rule.op])return 'Выбери поле и условие.';
    if(!String(rule.value).trim())return 'Введи значение фильтра.';
    if(numeric(rule.field)&&(!['eq','ne','gte','lte'].includes(rule.op)||!/^\d+$/.test(String(rule.value))))return 'Нужно целое неотрицательное число.';
    if(!numeric(rule.field)&&['gte','lte'].includes(rule.op))return 'Для текста выбери сравнение или поиск подстроки.';
    if(rule.field==='status'&&(Number(rule.value)<100||Number(rule.value)>599))return 'HTTP-статус должен быть от 100 до 599.';
    return '';
  }
  function matches(row,rules){return rules.every(rule=>{
    if(validate(rule))return false;
    const original=value(row,rule.field);if(original==null)return false;
    const actual=numeric(rule.field)?Number(original):String(original).toLowerCase();
    const expected=numeric(rule.field)?Number(rule.value):String(rule.value).toLowerCase();
    switch(rule.op){case 'contains':return actual.includes(expected);case 'not_contains':return !actual.includes(expected);case 'eq':return actual===expected;case 'ne':return actual!==expected;case 'gte':return actual>=expected;case 'lte':return actual<=expected;default:return false;}
  });}
  const wsRoleMatches=(row,role)=>!role||(role==='unknown'?!['client','server'].includes(row.ws_role):row.ws_role===role);
  const wsRoleLabel=role=>role==='client'?'WS · клиент':role==='server'?'WS · сервер':'WS · роль неизвестна';
  function contextFilter(value){
    if(value==null)return null;
    if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['id','label'].includes(key))||!Object.hasOwn(value,'id')||!Object.hasOwn(value,'label')||typeof value.id!=='string'||!value.id.length||value.id.length>128||/[^A-Za-z0-9._:/-]/.test(value.id)||typeof value.label!=='string'||!value.label.trim()||Array.from(value.label).length>256)throw Error('Неверный контекст захвата');
    return {id:value.id,label:value.label};
  }
  const api={contextFilter,wsRoleMatches,wsRoleLabel,fields,operators,numeric,validate,matches,statusMatches,statusText,label:rule=>`${fields[rule.field]} ${operators[rule.op]} ${rule.value}`};
  if(typeof module!=='undefined')module.exports=api;else root.LibriumFilters=api;
})(globalThis);
