import {it,expect} from 'vitest';
import {defaultHome,visibleWorkspaces} from '../src/lib/workspaces';
it('guidance users land on published results and have no scoring or management menu',()=>{
 const ctx={capabilities:['result.read_published'],roles:[],isGuidance:true};
 expect(defaultHome(ctx).path).toBe('/published-results');
 expect(visibleWorkspaces(ctx).flatMap(w=>w.items.map(i=>i.to)).sort()).toEqual(['/published-results']);
});
