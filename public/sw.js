/* MioBot notification worker. It deliberately does not cache pages or API data. */
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let data;try{data=event.data?.json();}catch{return;}
  if(!data||typeof data.notificationId!=='string'||!/^[-_:A-Za-z0-9]{1,160}$/.test(data.notificationId))return;
  const notificationId=data.notificationId;
  event.waitUntil(self.registration.showNotification('MioBot',{
    body:data.body==='这是一条连接测试，请核对手机是否收到。'?data.body:'有一条新消息，打开 MioBot 收件箱查看。',
    icon:'/app-icon.png',badge:'/app-icon.png',tag:'miobot-'+notificationId,
    data:{notificationId,url:'/?mobile=1&notification='+encodeURIComponent(notificationId)},
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const id=event.notification.data?.notificationId;
  if(typeof id!=='string'||!/^[-_:A-Za-z0-9]{1,160}$/.test(id))return;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const client=windows.find(w=>new URL(w.url).origin===self.location.origin);
    if(client){client.postMessage({type:'miobot:open-notification',notificationId:id});await client.focus();}
    else await self.clients.openWindow('/?mobile=1&notification='+encodeURIComponent(id));
  })());
});
self.addEventListener('pushsubscriptionchange',event=>{
  if(!event.newSubscription)return;
  event.waitUntil(fetch('/api/push/subscription',{
    method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Personal-Agent':'1'},
    body:JSON.stringify({subscription:event.newSubscription.toJSON()}),
  }).catch(()=>{}));
});
