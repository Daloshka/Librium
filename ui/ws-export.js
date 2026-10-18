(function(root){
  // At most one archive page is retained; writes are awaited for backpressure.
  async function exportSession({id,request,write,signal}){
    if(!Number.isSafeInteger(id)||id<1)throw Error('Неверный WebSocket');
    let after=0,through,total,count=0;
    for(;;){
      signal?.throwIfAborted();
      const page=await request(`traffic/${id}/ws-export?after=${after}`+(through===undefined?'':`&through=${through}`));
      signal?.throwIfAborted();
      if(!page||!Array.isArray(page.messages)||page.messages.length>100||typeof page.more!=='boolean'||!Number.isSafeInteger(page.through)||page.through<0||!Number.isSafeInteger(page.next)||page.next<after||page.next>page.through)throw Error('Неверная страница экспорта');
      if(through===undefined){
        const session=page.session;
        if(session?.version!==1||session.id!==id||!Number.isSafeInteger(session.total)||session.total<0||session.through!==page.through)throw Error('Неверный снимок WebSocket');
        through=page.through;total=session.total;
        await write(JSON.stringify({type:'session',...session})+'\n');
      }else if(through!==page.through)throw Error('Снимок экспорта изменился');
      let cursor=after;
      for(const message of page.messages){
        signal?.throwIfAborted();
        if(!Number.isSafeInteger(message.id)||message.id<=cursor||message.id>through)throw Error('Нарушен порядок сообщений экспорта');
        await write(JSON.stringify({type:'message',...message})+'\n');cursor=message.id;count++;
        if(count>total)throw Error('Число сообщений снимка изменилось');
      }
      if(cursor!==page.next||(page.more&&cursor===after))throw Error('Экспорт не продвигается');
      signal?.throwIfAborted();
      if(!page.more){
        if(count!==total)throw Error('История изменилась во время экспорта; выгрузка неполная');
        await write(JSON.stringify({type:'end',messages:count,through})+'\n');return {messages:count};
      }
      after=cursor;
    }
  }
  const api={exportSession};if(typeof module!=='undefined')module.exports=api;else root.LibriumWSExport=api;
})(globalThis);
