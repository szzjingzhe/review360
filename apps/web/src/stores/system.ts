import { defineStore } from 'pinia';

export type HealthState = 'pending' | 'ok' | 'bad';

export const useSystemStore = defineStore('system', {
  state: () => ({
    live: 'pending' as HealthState,
    ready: 'pending' as HealthState,
  }),
  actions: {
    setLive(state: HealthState) {
      this.live = state;
    },
    setReady(state: HealthState) {
      this.ready = state;
    },
  },
});
