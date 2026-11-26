import {validateReviewItems,reviewScoreBp} from '../src/review-score.js';
import { describe,expect,it } from 'vitest';
import { codePointLength,validateSubmitReasons,parseReasonThresholds } from '../src/reason-rules.js';
import { requiresItemReason,itemReasonError } from '../src/item-reasons.js';
describe('per-item reason policy',()=>{
  it.each([0,59,80,100])('requires 100 characters at %i',score=>{
    for(const kind of ['SELF','PEER'] as const){
      const input={kind,items:[{itemId:'metric',score,reason:'字'.repeat(99)}],scoreBp:score*100};
      expect(validateSubmitReasons(input)[0]).toMatchObject({itemId:'metric',requiredChars:100,actualChars:99});
      expect(validateSubmitReasons({...input,items:[{itemId:'metric',score,reason:' 😀'.trim().repeat(100)}]})).toEqual([]);
    }
  });
  it.each([60,79])('allows empty reason at %i',score=>{
    expect(validateSubmitReasons({kind:'PEER',items:[{itemId:'m',score,reason:null}],scoreBp:10000,peerScoreBpIncludingThis:[10000,10000,10000,10000]})).toEqual([]);
  });
  it('counts trimmed Unicode code points, including internal newlines',()=>{
    expect(codePointLength('  😀中文  ')).toBe(3);expect(codePointLength(' 中\n文 ')).toBe(3);expect(codePointLength(' \n ')).toBe(0);
    expect(itemReasonError(80,' '.repeat(100))).not.toBe('');expect(itemReasonError(80,'字'.repeat(100))).toBe('');
    expect(requiresItemReason(null)).toBe(false);expect(requiresItemReason(0)).toBe(true);
  });
  it('does not alter historical calibration thresholds or restore overall-text rules',()=>{
    const thresholds=parseReasonThresholds({score:{high_bp:9000},reasons:{item_min_chars:30}});
    expect(thresholds.highBp).toBe(9000);expect(thresholds.itemMinChars).toBe(30);
    expect(validateSubmitReasons({kind:'SELF',items:[{itemId:'m',score:80,reason:''}],scoreBp:8000},thresholds)[0].requiredChars).toBe(100);
  });
});

describe('versioned PRD reason policy',()=>{
 const rules=parseReasonThresholds({score:{high_bp:9000,low_bp:6000},reasons:{policy:'prd_v1',item_min_chars:30,overall_min_chars:50,low_overall_min_chars:30}});
 it.each([59,60,79,80,89,90,94,95,100])('applies the configured boundary at %i',score=>{
  const violations=validateSubmitReasons({kind:'SELF',items:[{itemId:'x',score,reason:'字'.repeat(29)}],scoreBp:score*100,overallReason:'字'.repeat(49)},rules);
  expect(violations.some(v=>v.code==='HIGH_ITEM_REASON_REQUIRED')).toBe(score>=90);
  expect(violations.some(v=>v.code==='OVERALL_STATEMENT_REQUIRED')).toBe(score>=90);
 });
 it.each(['SELF','PEER'] as const)('checks low and high reasons independently for %s',kind=>{
  const input={kind,items:[{itemId:'low',score:59,reason:null},{itemId:'high',score:90,reason:'字'.repeat(29)}],scoreBp:9000,overallReason:'字'.repeat(49)};
  expect(validateSubmitReasons(input,rules).map(v=>v.code)).toEqual(['HIGH_ITEM_REASON_REQUIRED','OVERALL_STATEMENT_REQUIRED']);
  expect(validateSubmitReasons({...input,items:[input.items[0],{...input.items[1],reason:'字'.repeat(30)}],overallReason:'字'.repeat(50)},rules)).toEqual([]);
 });
 it('rejects whitespace and punctuation padding',()=>{
  expect(validateSubmitReasons({kind:'PEER',items:[{itemId:'x',score:90,reason:'！ '.repeat(40)}],scoreBp:9000,overallReason:'。'.repeat(60)},rules)).toHaveLength(2);
 });
});

// Arbitrary configurable fixture, not a proposed production four-dimension template or reason policy.
describe('template completeness and score validity',()=>{
 const tpl=[{id:'one',weight:30},{id:'two',weight:25},{id:'three',weight:25},{id:'four',weight:20}];
 const full=tpl.map(t=>({itemId:t.id,score:70}));
 it('requires every configured dimension; never renormalizes a partial form',()=>{expect(()=>reviewScoreBp(tpl,full.slice(0,3))).toThrow('REQUIRED_ITEM_MISSING');});
 it('rejects repeated and foreign dimensions',()=>{expect(()=>reviewScoreBp(tpl,[...full,full[0]])).toThrow('DUPLICATE_ITEM');expect(()=>reviewScoreBp(tpl,[...full.slice(0,3),{itemId:'foreign',score:70}])).toThrow('ITEM_NOT_IN_TEMPLATE');});
 it.each([-1,101,70.5,NaN,Infinity,'70',null])('rejects invalid submitted score %s',score=>{expect(()=>reviewScoreBp(tpl,[{itemId:'one',score},...full.slice(1)])).toThrow('SCORE_INVALID');});
 it('incomplete drafts remain saveable, but not submitted',()=>{expect(validateReviewItems(tpl,[{itemId:'one',score:null}],false)).toHaveLength(1);expect(()=>reviewScoreBp(tpl,[{itemId:'one',score:null}])).toThrow();});
 it('uses exactly the configured weights for a complete form',()=>{expect(reviewScoreBp(tpl,full)).toBe(7000);expect(()=>reviewScoreBp([{id:'one',weight:99}],full.slice(0,1))).toThrow('TEMPLATE_INVALID');});
});
