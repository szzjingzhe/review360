import {describe,it,expect} from 'vitest';
import {APPEAL_SCOPES,encodeAppeal,decodeAppeal,validateAppealReason} from '../src/appeal-classification';
describe('appeal classification write validation and historical reads',()=>{
 for(const [type,scopes] of Object.entries(APPEAL_SCOPES))for(const scope of scopes.length?scopes:[''])it(`${type}: ${scope||'no scope'}`,()=>{
  const text=encodeAppeal(type,scope?[scope]:[],'  事实依据\n补充说明  ');expect(validateAppealReason(text)).toBe(text);expect(decodeAppeal(text).scope).toBe(scope||'未指定');
 });
 it('rejects unknown types, unknown scopes, cross-category and multi-selection',()=>{
  for(const [type,scopes] of [['未知类型',['整体成长分析']],['评价结果异议',['评价提交']],['评价依据异议',['原始评分']],['评价流程问题',['评价任务','结果发布']],['评价数据问题',[]]] as Array<[string,string[]]>)expect(()=>validateAppealReason(encodeAppeal(type,scopes,'事实'))).toThrow();
  expect(()=>validateAppealReason('【申诉类型】其他问题\n【涉及范围】评价任务\n\n事实')).toThrow('FEEDBACK_SCOPE_INVALID');
  expect(()=>validateAppealReason(null)).toThrow('FEEDBACK_REASON_INVALID');
  expect(()=>validateAppealReason('旧格式不能用于新提交')).toThrow('FEEDBACK_TYPE_INVALID');
 });
 it('enforces 500 Unicode characters on body without counting metadata',()=>{
  expect(()=>validateAppealReason(encodeAppeal('其他问题',[],'😀'.repeat(500)))).not.toThrow();
  expect(()=>validateAppealReason(encodeAppeal('其他问题',[],'中'.repeat(501)))).toThrow('FEEDBACK_REASON_INVALID');
  expect(()=>validateAppealReason(encodeAppeal('其他问题',[],' \n\t '))).toThrow('FEEDBACK_REASON_INVALID');
 });
 it('preserves legacy plain and multiple-dimension records',()=>{
  expect(decodeAppeal('历史原文')).toEqual({type:'历史反馈',scope:'未记录',reason:'历史原文'});
  expect(decodeAppeal(encodeAppeal('评价结果异议',['任务交付','学习成长'],'历史理由'))).toEqual({type:'评价结果异议',scope:'任务交付、学习成长',reason:'历史理由'});
 });
});
