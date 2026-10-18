// Node worker inspectors use a nested protocol channel, not flat CDP sessions.
// Keep command replies outside the ingest queue so worker setup cannot deadlock.
const {randomUUID}=require('node:crypto');
const {guardNodeWorkers}=require('./node-worker-guard.cjs');
class WorkerSocket extends EventTarget {
  constructor(parent,id){super();this.parent=parent;this.id=id;this.readyState=1;}
  send(message){if(this.readyState!==1)throw Error('Отладчик worker закрыт');this.parent.command('NodeWorker.sendMessageToWorker',{sessionId:this.id,message}).catch(()=>this.close());}
  receive(message){if(this.readyState!==1)return;const event=new Event('message');event.data=message;this.dispatchEvent(event);}
  drop(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
  close(){if(this.readyState===3)return;this.drop();this.parent.command('NodeWorker.detach',{sessionId:this.id}).catch(()=>{});}
}
class NodeWorkers {
  constructor(parent,create){this.parent=parent;this.create=create;this.sessions=new Map();this.jobs=new Set();this.closing=false;this.retired={exchanges:0,messages:0};this.warning=null;this.error=null;}
  async enable(){try{
    this.guard='__libriumWorkerGuard'+randomUUID().replaceAll('-','');
    this.binding='libriumWorker'+randomUUID().replaceAll('-','');
    await this.parent.command('Runtime.addBinding',{name:this.binding});
    const value=await this.parent.command('Runtime.evaluate',{expression:`(${guardNodeWorkers.toString()})(${JSON.stringify(this.guard)},${JSON.stringify(this.binding)})`,returnByValue:true});
    if(value.result?.value!==true)throw Error('Worker guard unavailable');
    this.guardTimer=setInterval(()=>{void this.parent.command('Runtime.evaluate',{expression:`globalThis[${JSON.stringify(this.guard)}]?.renew()`}).catch(()=>{});},1000);this.guardTimer.unref?.();
    await this.command('NodeWorker.enable',{waitForDebuggerOnStart:true});return true;
  }catch{clearInterval(this.guardTimer);await this.stopGuard();this.warning='Node worker_threads недоступны через этот отладчик.';return false;}}
  async command(method,params){const value=await this.parent.command('Runtime.evaluate',{expression:`globalThis[${JSON.stringify(this.guard)}].command(${JSON.stringify(method)},${JSON.stringify(params||{})})`,returnByValue:true});if(value.exceptionDetails)throw Error('Worker channel closed');return value.result?.value;}
  async finishGuard(id){if(!this.guard)return;await this.parent.command('Runtime.evaluate',{expression:`globalThis[${JSON.stringify(this.guard)}]?.finish(${JSON.stringify(id)})`}).catch(()=>{});}
  async stopGuard(){if(!this.guard)return;await this.parent.command('Runtime.evaluate',{expression:`globalThis[${JSON.stringify(this.guard)}]?.stop()`,awaitPromise:true}).catch(()=>{});if(this.binding)await this.parent.command('Runtime.removeBinding',{name:this.binding}).catch(()=>{});}
  status(){let targets=0,exchanges=this.retired.exchanges,messages=this.retired.messages;const errors=[];for(const row of this.sessions.values()){const value=row.capture.status();targets+=value.targets;exchanges+=value.exchanges;messages+=value.messages;if(value.error)errors.push(value.error);}return {targets,exchanges,messages,warning:this.warning,error:[this.error,...errors].filter(Boolean).slice(0,3).join(' · ')||null};}
  route(data){
    const p=data.params||{};
    if(data.method==='Librium.workerLimit'){this.warning='Достигнут лимит 32 Node workers; остальные продолжают работу без наблюдения.';return true;}
    if(data.method==='NodeWorker.receivedMessageFromWorker'){
      const row=this.sessions.get(p.sessionId);if(row&&typeof p.message==='string'){if(Buffer.byteLength(p.message)>16*1024*1024){row.capture.info.error='Отладочное сообщение worker превысило 16 МиБ';row.socket.close();}else row.socket.receive(p.message);}return true;
    }
    if(data.method==='NodeWorker.attachedToWorker'){this.attach(p);return true;}
    if(data.method==='NodeWorker.detachedFromWorker'){const row=this.sessions.get(p.sessionId);if(row){row.socket.drop();this.retire(row,false);}return true;}
    return false;
  }
  release(id){this.command('NodeWorker.sendMessageToWorker',{sessionId:id,message:JSON.stringify({id:1,method:'Runtime.runIfWaitingForDebugger'})}).catch(()=>{}).finally(()=>this.command('NodeWorker.detach',{sessionId:id}).catch(()=>{}));}
  attach(p){
    const id=p.sessionId;if(typeof id!=='string'||!id||id.length>256||this.sessions.has(id))return;
    if(this.closing||this.parent.workerBudget.active>=32){if(!this.closing)this.warning='Достигнут лимит 32 Node workers; остальные продолжают работу без наблюдения.';this.release(id);return;}
    this.parent.workerBudget.active++;
    const capture=this.create({ingest:this.parent.ingest,mode:'node',workerBudget:this.parent.workerBudget,queueBudget:this.parent.queueBudget,recordLimit:64,onWarning:message=>{this.warning='Node worker: '+String(message).slice(0,400);}}),socket=new WorkerSocket(this,id);
    const label='Node worker '+String(p.workerInfo?.workerId||id).slice(0,32)+' · '+Array.from(String(p.workerInfo?.title||'worker_threads').toWellFormed()).slice(0,128).join('');
    const row={id,capture,socket,ready:false,retiring:null};this.sessions.set(id,row);
    const job=capture.connectWorker(socket,{port:this.parent.info.port,title:label,entryUrl:p.workerInfo?.url,waiting:p.waitingForDebugger===true}).then(()=>{row.ready=true;if(capture.info.startup==='unconfirmed')this.warning='Начало части Node workers не подтверждено; ранние запросы могут отсутствовать.';if(!capture.observer?.active)this.warning='Наблюдатель сообщений части Node workers недоступен в этом runtime.';}).catch(async()=>{if(!this.closing&&socket.readyState===1)this.warning='Часть Node workers не удалось подключить; они продолжили работу.';socket.close();await this.retire(row,false);}).finally(async()=>{await this.finishGuard(id);this.jobs.delete(job);});this.jobs.add(job);
  }
  retire(row,disconnect){
    if(row.retiring)return row.retiring;
    row.retiring=(async()=>{
      if(disconnect&&row.ready)await row.capture.disconnect();else{row.socket.drop();await row.capture.workers?.stop(true);await row.capture.queue;}
      const value=row.capture.status();if(value.error&&!this.closing)this.error=value.error;this.retired.exchanges+=value.exchanges;this.retired.messages+=value.messages;
      if(this.sessions.get(row.id)===row){this.sessions.delete(row.id);this.parent.workerBudget.active--;}
    })().catch(()=>{if(this.sessions.get(row.id)===row){this.sessions.delete(row.id);this.parent.workerBudget.active--;}});
    return row.retiring;
  }
  async settle(){await Promise.allSettled([...this.jobs]);}
  async stop(lost=false){
    if(this.stopped)return this.stopped;this.closing=true;clearInterval(this.guardTimer);
    this.stopped=(async()=>{
      if(!lost)await this.command('NodeWorker.enable',{waitForDebuggerOnStart:false}).catch(()=>{});
      const rows=[...this.sessions.values()];for(const row of rows)if(lost||!row.ready)row.socket.close();
      await Promise.allSettled(rows.map(row=>this.retire(row,!lost)));await this.settle();
      if(!lost){await this.command('NodeWorker.disable').catch(()=>{});await this.stopGuard();}
    })();return this.stopped;
  }
}
module.exports={NodeWorkers,WorkerSocket};
