import { create } from 'zustand';
import axios from 'axios';

export interface AppState {
  jobs: any[];
  candidates: any[];
  applications: any[];
  interviews: any[];
  scorecards: any[];
  offers: any[];
  onboardingTasks: any[];
}

interface StoreState extends AppState {
  currentRole: 'recruiter' | 'candidate' | 'hiring-manager' | 'documentation';
  setRole: (role: 'recruiter' | 'candidate' | 'hiring-manager' | 'documentation') => void;
  fetchState: () => Promise<void>;
  resetState: () => Promise<void>;
}

export const useStore = create<StoreState>((set) => ({
  jobs: [],
  candidates: [],
  applications: [],
  interviews: [],
  scorecards: [],
  offers: [],
  onboardingTasks: [],
  currentRole: 'recruiter',
  setRole: (role) => set({ currentRole: role }),
  fetchState: async () => {
    const res = await axios.get('/api/state');
    set(res.data);
  },
  resetState: async () => {
    await axios.post('/api/reset');
    const res = await axios.get('/api/state');
    set(res.data);
  }
}));
