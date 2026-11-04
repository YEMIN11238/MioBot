import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {DeviceSessions,DEVICE_COOKIE,PAIRING_TTL,DEVICE_SESSION_TTL,parseCookie,cookieHeader,removeCookie} from '../server/device-sessions.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'miobot-device-grants-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let now=Date.parse('2026-11-04T01:00:00Z');const store=new Store(root),devices=new DeviceSessions({store,now:()=>now});
  return {root,store,devices,advance:amount=>now+=amount,now:()=>now};
}
function rejects(fn,code,status){assert.throws(fn,error=>error.code===code&&error.status===status);}

test('pairing returns its code once and credentials contain only hashes, outside ordinary state',t=>{
  const {store,devices}=fixture(t),grant=devices.issuePairing({label:'我的 iPhone'});
  assert.match(grant.code,/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  assert.equal(Date.parse(grant.expiresAt)-Date.parse('2026-11-04T01:00:00Z'),PAIRING_TTL);
  const persisted=JSON.stringify(store.secrets);
  assert.equal(persisted.includes(grant.code),false);assert.equal(persisted.includes(grant.code.replace('-','')),false);
  assert.equal(JSON.stringify(store.snapshot()).includes(grant.id),false);assert.deepEqual(devices.list(),[]);
});

test('exchange consumes the code, survives restart and never returns the session hash publicly',t=>{
  const {root,store,devices,now}=fixture(t),grant=devices.issuePairing({label:'我的手机'}),session=devices.exchange({code:grant.code.toLowerCase().replace('-',' '),label:'iPhone · Safari'},'fixture-peer');
  assert.match(session.token,/^mdev_[A-Za-z0-9_-]{43}$/);assert.equal(session.device.role,'personal');assert.equal(session.device.label,'iPhone · Safari');
  assert.equal(Date.parse(session.device.expiresAt)-now(),DEVICE_SESSION_TTL);
  const persisted=readFileSync(store.secretFile,'utf8');assert.equal(persisted.includes(session.token),false);assert.equal(persisted.includes(grant.code),false);
  for(const value of [session.device,devices.list(),devices.authenticate(session.token),store.snapshot()]){const text=JSON.stringify(value);assert.equal(text.includes(session.token),false);assert.equal(text.includes('tokenHash'),false);assert.equal(text.includes('codeHash'),false);}
  const restarted=new DeviceSessions({store:new Store(root),now});assert.equal(restarted.authenticate(session.token).id,session.device.id);
  rejects(()=>restarted.exchange({code:grant.code},'fixture-peer'),'INVALID_PAIRING',401);
});

test('expired codes and sessions fail at their exact expiry, and arbitrary owner-like tokens fail',t=>{
  const {devices,advance}=fixture(t),expired=devices.issuePairing();advance(PAIRING_TTL);
  rejects(()=>devices.exchange({code:expired.code},'peer-a'),'INVALID_PAIRING',401);
  const session=devices.exchange({code:devices.issuePairing().code},'peer-b');
  assert.equal(devices.authenticate('synthetic-owner-key-that-is-not-a-device-session'),null);
  assert.equal(devices.authenticate(session.token+'x'),null);advance(DEVICE_SESSION_TTL);
  assert.equal(devices.authenticate(session.token),null);assert.deepEqual(devices.list(),[]);
});

test('revocation and logout affect only their own device grants',t=>{
  const {devices}=fixture(t),one=devices.exchange({code:devices.issuePairing({label:'手机'}).code},'one'),two=devices.exchange({code:devices.issuePairing({label:'平板'}).code},'two');
  const revoked=devices.revoke(one.device.id);assert.ok(revoked.revokedAt);assert.equal(devices.authenticate(one.token),null);assert.ok(devices.authenticate(two.token));
  assert.equal(devices.revoke(one.device.id).revokedAt,revoked.revokedAt);assert.equal(devices.revoke('unknown-device'),null);
  assert.equal(devices.logout(two.token),true);assert.equal(devices.logout(two.token),false);assert.equal(devices.authenticate(two.token),null);assert.deepEqual(devices.list(),[]);
});

test('invalid guesses are limited per peer without revealing whether a code existed',t=>{
  const {devices,advance}=fixture(t),grant=devices.issuePairing();
  for(let i=0;i<8;i++)rejects(()=>devices.exchange({code:'XXXXXXXX'},'peer-a'),'INVALID_PAIRING',401);
  rejects(()=>devices.exchange({code:grant.code},'peer-a'),'PAIRING_RATE_LIMIT',429);
  const other=devices.exchange({code:grant.code},'peer-b');assert.ok(devices.authenticate(other.token));advance(10*60*1000);
  assert.ok(devices.exchange({code:devices.issuePairing().code},'peer-a').token);
});

test('device labels cannot smuggle markup or controls and never consume a valid code on validation failure',t=>{
  const {store,devices}=fixture(t),grant=devices.issuePairing({label:'手机'}),before=JSON.stringify(store.secrets);
  for(const bad of ['',42,'<script>','hello\nworld','x'.repeat(81)]){
    rejects(()=>devices.issuePairing({label:bad}),'INVALID_DEVICE_LABEL',400);
    rejects(()=>devices.exchange({code:grant.code,label:bad},'peer'),'INVALID_DEVICE_LABEL',400);
  }
  assert.equal(JSON.stringify(store.secrets),before);assert.equal(devices.exchange({code:grant.code},'peer').device.label,'手机');
});

test('non-object requests are rejected before they can modify pairing or device state',t=>{
  const {store,devices}=fixture(t),before=JSON.stringify(store.secrets);
  for(const value of [null,[],42,'fixture']){
    rejects(()=>devices.issuePairing(value),'INVALID_DEVICE_REQUEST',400);
    rejects(()=>devices.exchange(value,'peer'),'INVALID_DEVICE_REQUEST',400);
  }
  assert.equal(JSON.stringify(store.secrets),before);
});

test('failed credential persistence does not authorize a device or spend a code',t=>{
  const {store,devices}=fixture(t),grant=devices.issuePairing(),before=structuredClone(store.secrets.deviceAccess),save=store.setSecrets.bind(store);
  store.setSecrets=values=>{Object.assign(store.secrets,values);throw Error('synthetic storage failure');};
  rejects(()=>devices.exchange({code:grant.code},'peer'),'DEVICE_STORE_FAILED',503);assert.deepEqual(store.secrets.deviceAccess,before);assert.deepEqual(devices.list(),[]);
  store.setSecrets=save;assert.ok(devices.exchange({code:grant.code},'peer').token);
});

test('pairing issuance is bounded and expired outstanding codes free capacity',t=>{
  const {devices,advance}=fixture(t);for(let i=0;i<8;i++)devices.issuePairing();
  rejects(()=>devices.issuePairing(),'PAIRINGS_FULL',429);advance(PAIRING_TTL);assert.ok(devices.issuePairing().code);
});

test('cookie helpers keep tokens out of JavaScript, scope them to the host and reject duplicate or malformed cookies',t=>{
  const {devices}=fixture(t),{token}=devices.exchange({code:devices.issuePairing().code},'peer'),plain=cookieHeader(token),secure=cookieHeader(token,{secure:true});
  assert.match(plain,/HttpOnly/);assert.match(plain,/SameSite=Strict/);assert.match(plain,/Path=\//);assert.equal(plain.includes('Domain='),false);assert.equal(plain.includes('Secure'),false);assert.match(secure,/; Secure$/);
  assert.equal(parseCookie('other=fixture; '+DEVICE_COOKIE+'='+token),token);assert.equal(parseCookie(DEVICE_COOKIE+'='+token+'; '+DEVICE_COOKIE+'='+token),null);
  for(const raw of [undefined,DEVICE_COOKIE+'=%ZZ',DEVICE_COOKIE+'=not-a-token','x'.repeat(8193)])assert.equal(parseCookie(raw),null);
  assert.throws(()=>cookieHeader(token+'\r\nInjected: value'));assert.throws(()=>cookieHeader(token,{maxAge:Infinity}));assert.match(removeCookie({secure:true}),/Max-Age=0/);assert.match(removeCookie({secure:true}),/; Secure$/);
});
