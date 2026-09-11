import assert from 'node:assert/strict';
import { eventLines, formatCivilEvent, locationFromSearchResult } from '../src/ui/presentation.js';
import { searchLocal } from '../src/ui/search.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`✓ ${name}`); };
const date = new Date('2024-06-21T00:00:00Z');
const ev = { noon: 720, sunrise: 360, sunset: 1080 };

test('空时区不显示民用时行', () => assert.equal(eventLines(date, ev, {}, 0, 0).civil, null));
test('UTC 固定偏移 0 仍显示', () => assert.match(eventLines(date, ev, { tzOffsetMin: 0 }, 0, 0).civil, /固定偏移/));
test('固定偏移 +480 正确换算', () => assert.equal(formatCivilEvent(date, 60, { tzOffsetMin: 480 }), '09:00'));
test('IANA 时区按日期应用夏令时', () => assert.equal(formatCivilEvent(date, 720, { timeZoneId: 'America/New_York' }), '08:00'));
test('极地事件显示横线而不伪造时间', () => assert.match(eventLines(date, { noon: 720, sunrise: null, sunset: null }, { tzOffsetMin: 480 }, 0, 0).civil, /日出 — · 日落 —/));
test('在线结果未知时区保持 null', () => assert.deepEqual(locationFromSearchResult({ name: 'X', latitude: 1, longitude: 2 }), { name: 'X', latitude: 1, longitude: 2, timeZoneId: null, tzOffsetMin: null }));
test('GeoNames 本地搜索保留 IANA 时区', () => {
  const rows = [{ geonameId: 1, name: 'Beijing', asciiName: 'Beijing', aliases: ['北京'], lat: 39.9, lon: 116.4, countryCode: 'CN', population: 1, timeZoneId: 'Asia/Shanghai' }];
  assert.equal(searchLocal('北京', rows)[0].timeZoneId, 'Asia/Shanghai');
});
console.log(`UI 通过 ${passed} / 失败 0`);
