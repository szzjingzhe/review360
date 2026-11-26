import {describe,it,expect} from 'vitest';
import {guidanceRequestAllowed} from '../src/auth/session.guard';
describe('guidance read-only boundary',()=>{
 it('allows only authenticated identity, directory, published-results and logout',()=>{
 for(const p of ['/me','/organization','/organization/members','/published-results'])expect(guidanceRequestAllowed('GET','/api/v1'+p)).toBe(true);
 expect(guidanceRequestAllowed('POST','/api/v1/auth/logout')).toBe(true);
 for(const p of ['/reviews/123','/me/results','/cycles','/capability-grants','/published-results/raw'])for(const method of ['GET','POST','PATCH','DELETE'])expect(guidanceRequestAllowed(method,'/api/v1'+p)).toBe(false);
 expect(guidanceRequestAllowed('POST','/api/v1/published-results')).toBe(false);
 });
});
