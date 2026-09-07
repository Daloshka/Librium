(function(root){
  const i18n=typeof module!=='undefined'?require('./i18n.js'):root.LibriumI18n;
  const t=key=>i18n?i18n.t(key):key;
  const fields={host:t('field.host'),path:t('field.path'),url:t('field.url'),method:t('field.method'),status:t('field.status'),id:t('field.id'),size:t('field.size')};
  const operators={contains:t('op.contains'),not_contains:t('op.not_contains'),eq:t('op.eq'),ne:t('op.ne'),gte:t('op.gte'),lte:t('op.lte')};
  const numeric=field=>['status','id','size'].includes(field);
  function value(row,field){if(field==='host'||field==='path'){try{const url=new URL(row.url);return field==='host'?url.hostname:url.pathname+url.search;}catch{return '';}}return row[field];}
  function validate(rule){
    if(!fields[rule.field]||!operators[rule.op])return t('rule.field');
    if(!String(rule.value).trim())return t('rule.value');
    if(numeric(rule.field)&&(!['eq','ne','gte','lte'].includes(rule.op)||!/^\d+$/.test(String(rule.value))))return t('rule.integer');
    if(!numeric(rule.field)&&['gte','lte'].includes(rule.op))return t('rule.textOperator');
    if(rule.field==='status'&&(Number(rule.value)<100||Number(rule.value)>599))return t('rule.statusRange');
    return '';
  }
  function matches(row,rules){return rules.every(rule=>{
    if(validate(rule))return false;
    const original=value(row,rule.field);if(original==null)return false;
    const actual=numeric(rule.field)?Number(original):String(original).toLowerCase();
    const expected=numeric(rule.field)?Number(rule.value):String(rule.value).toLowerCase();
    switch(rule.op){case 'contains':return actual.includes(expected);case 'not_contains':return !actual.includes(expected);case 'eq':return actual===expected;case 'ne':return actual!==expected;case 'gte':return actual>=expected;case 'lte':return actual<=expected;default:return false;}
  });}
  const api={fields,operators,numeric,validate,matches,label:rule=>`${fields[rule.field]} ${operators[rule.op]} ${rule.value}`};
  if(typeof module!=='undefined')module.exports=api;else root.LibriumFilters=api;
})(globalThis);
