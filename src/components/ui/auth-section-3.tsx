"use client";

import { useState, type FormEvent, type ReactNode } from 'react';
import harshavardhanImage from '../../assets/Harshavardhan_Bajoria.jpg';
import { FlutedGlass } from '@paper-design/shaders-react';
import { Eye, EyeOff, Mail, UserPlus } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import PipelineLogo from '../PipelineLogo';

export type AuthSectionMode = 'signin' | 'register';

export interface AuthSectionThreeProps {
  mode: AuthSectionMode;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  busy: boolean;
  error: string | null;
  onModeChange: (mode: AuthSectionMode) => void;
  onFirstNameChange: (value: string) => void;
  onLastNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onGoogleSignIn: () => void;
}

export default function AuthSectionThree({
  mode,
  firstName,
  lastName,
  email,
  password,
  busy,
  error,
  onModeChange,
  onFirstNameChange,
  onLastNameChange,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onGoogleSignIn
}: AuthSectionThreeProps) {
  const reduceMotion = useReducedMotion();

  return (
    <section className="min-h-screen bg-white p-3 text-black antialiased [font-synthesis:none] dark:bg-[#050505] dark:text-white">
      <div className="grid min-h-[calc(100vh-1.5rem)] gap-6 lg:grid-cols-[0.94fr_1.06fr]">
        <div className="flex min-h-[760px] items-center justify-center rounded-md border border-black/10 bg-white px-6 py-12 dark:border-white/5 dark:bg-[#0a0a0c] lg:min-h-0 lg:px-14 lg:py-20 xl:px-20">
          <div className="mx-auto w-full max-w-[460px]">
            <PipelineLogo tone="light" full className="mb-10" />
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-black/40 dark:text-white/35">
                Secure recruiting workspace
              </p>
              <h1 className="text-3xl font-medium tracking-tight text-black dark:text-white sm:text-4xl">
                {mode === 'signin' ? 'Welcome back' : 'Create an account'}
              </h1>
              <p className="mt-3 max-w-md text-sm leading-6 text-black/55 dark:text-white/45">
                {mode === 'signin'
                  ? 'Sign in to continue your candidate, recruiter, or hiring team workflow.'
                  : 'Create a secure account for shared, auditable recruiting workflows.'}
              </p>
            </div>

            <div className="mt-8">
              <button
                type="button"
                onClick={onGoogleSignIn}
                disabled={busy}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-black/15 bg-white px-4 text-sm font-medium text-black transition-colors hover:bg-black/[0.02] disabled:cursor-wait disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
              >
                <GoogleIcon />
                <span className="whitespace-nowrap">
                  {mode === 'signin' ? 'Continue with Google' : 'Sign up with Google'}
                </span>
              </button>
            </div>

            <div className="my-6 flex items-center gap-4 text-xs font-medium text-black/40 dark:text-white/30">
              <div className="h-px flex-1 bg-black/10 dark:bg-white/10" />
              or
              <div className="h-px flex-1 bg-black/10 dark:bg-white/10" />
            </div>

            {error && (
              <div role="alert" className="mb-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-5 text-red-800 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
                {error}
              </div>
            )}

            <form onSubmit={onSubmit} className="space-y-4">
              {mode === 'register' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <InputField
                    label="First name"
                    value={firstName}
                    placeholder="First name"
                    onChange={onFirstNameChange}
                    disabled={busy}
                  />
                  <InputField
                    label="Last name"
                    value={lastName}
                    placeholder="Last name"
                    onChange={onLastNameChange}
                    disabled={busy}
                  />
                </div>
              )}
              <InputField
                label="Email"
                value={email}
                placeholder="email@example.com"
                type="email"
                autoComplete="email"
                onChange={onEmailChange}
                disabled={busy}
              />
              <InputField
                label="Password"
                value={password}
                placeholder="At least 6 characters"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                onChange={onPasswordChange}
                disabled={busy}
              />

              {mode === 'register' && (
                <div className="space-y-3 pt-2 text-xs leading-5 text-black/45 dark:text-white/40 sm:text-[13px]">
                  <CheckboxLine>
                    I would like occasional updates about PipelineOS recruiting workflows.
                  </CheckboxLine>
                  <CheckboxLine>
                    By creating an account, you agree to our{' '}
                    <a href="#terms" className="font-medium text-black/55 underline underline-offset-2 dark:text-white/55">
                      Terms of Service
                    </a>{' '}
                    and{' '}
                    <a href="#privacy" className="font-medium text-black/55 underline underline-offset-2 dark:text-white/55">
                      Privacy Policy
                    </a>
                  </CheckboxLine>
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="mt-8 flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-black/40 bg-black text-sm font-medium text-white transition-colors hover:bg-black/85 disabled:cursor-wait disabled:opacity-60 dark:border-white/40 dark:bg-white dark:text-black dark:hover:bg-white/85"
              >
                {mode === 'signin' ? <Mail className="size-4" aria-hidden="true" /> : <UserPlus className="size-4" aria-hidden="true" />}
                {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in with email' : 'Create account'}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-black/50 dark:text-white/45">
              {mode === 'signin' ? 'New to PipelineOS?' : 'Already have an account?'}{' '}
              <button
                type="button"
                onClick={() => onModeChange(mode === 'signin' ? 'register' : 'signin')}
                disabled={busy}
                className="font-semibold text-black underline underline-offset-2 transition-colors hover:text-black/60 disabled:opacity-50 dark:text-white dark:hover:text-white/70"
              >
                {mode === 'signin' ? 'Create an account' : 'Sign in'}
              </button>
            </p>
          </div>
        </div>

        <div className="relative flex min-h-[720px] flex-col overflow-hidden rounded-md bg-linear-to-b from-black to-white p-8 text-white dark:to-[#050505] sm:p-12 lg:min-h-0 lg:p-16">
          <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
            <FlutedGlass
              size={0.89}
              shape="lines"
              angle={0}
              distortionShape="prism"
              distortion={0.5}
              shift={0}
              blur={0}
              edges={0.25}
              stretch={0}
              scale={1.11}
              fit="cover"
              highlights={0.1}
              shadows={0.2}
              grainMixer={0.1}
              grainOverlay={0.1}
              colorBack="#00000000"
              colorHighlight="#FFFFFF"
              colorShadow="#000000"
              className="h-full w-full bg-transparent"
            />
          </div>

          <div className="relative z-10 h-full w-full">
            <div className="max-w-[500px] lg:pt-12">
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, y: 12, filter: 'blur(6px)' }}
                whileInView={reduceMotion ? undefined : { opacity: 1, y: 0, filter: 'blur(0px)' }}
                viewport={{ once: true, margin: '-10%' }}
                transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                className="flex items-center gap-4"
              >
                <img
                  src={harshavardhanImage}
                  alt="Harshavardhan Bajoria"
                  className="size-10 shrink-0 rounded-full border border-white/20 object-cover"
                />
                <div>
                  <div className="font-semibold leading-tight text-white">Harshavardhan</div>
                  <div className="mt-0.5 text-xs text-white/60">Talent Acquisition · Global Head</div>
                </div>
              </motion.div>
              <motion.blockquote
                initial={reduceMotion ? false : { opacity: 0, y: 18, filter: 'blur(8px)' }}
                whileInView={reduceMotion ? undefined : { opacity: 1, y: 0, filter: 'blur(0px)' }}
                viewport={{ once: true, margin: '-10%' }}
                transition={{ duration: 0.8, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
                className="mt-7 text-2xl font-light leading-tight tracking-[-0.035em] text-white/90 sm:text-3xl lg:text-[34px]"
              >
                “PipelineOS gives every hiring team one clear, auditable path from sourcing to onboarding.”
              </motion.blockquote>
            </div>

            <div className="mt-10 w-full translate-y-[24%] overflow-hidden rounded-2xl border border-white/15 bg-black/70 p-2 shadow-[0_30px_90px_rgba(0,0,0,0.5)] backdrop-blur-xl sm:translate-y-[22%] lg:absolute lg:bottom-[-7rem] lg:left-[12%] lg:mt-0 lg:w-[105%] lg:max-w-none lg:origin-bottom-left lg:translate-y-0 lg:-rotate-3 xl:bottom-[-9.5rem] xl:left-[14%] xl:w-[108%] 2xl:bottom-[-10.5rem] 2xl:w-[112%]">
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, y: 72, filter: 'blur(10px)' }}
                whileInView={reduceMotion ? undefined : { opacity: 1, y: 0, filter: 'blur(0px)' }}
                viewport={{ once: true, margin: '-10%' }}
                transition={{ duration: 1, delay: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden rounded-xl border border-white/10 bg-black"
              >
                <div className="flex items-center gap-1.5 border-b border-white/10 bg-black/40 px-4 py-3 select-none">
                  <div className="size-2 rounded-full bg-white/35" />
                  <div className="size-2 rounded-full bg-white/25" />
                  <div className="size-2 rounded-full bg-white/15" />
                  <span className="ml-4 font-mono text-[9px] tracking-wider text-white/40">pipelineos.app/workspace</span>
                </div>
                <DashboardMockup />
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function InputField({
  label,
  placeholder,
  type = 'text',
  autoComplete,
  value,
  onChange,
  disabled = false
}: {
  label: string;
  placeholder: string;
  type?: string;
  autoComplete?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === 'password';

  return (
    <div className="w-full space-y-1.5 text-left">
      <label className="text-xs font-semibold text-black/60 dark:text-white/60">
        {label}
      </label>
      <div className="relative flex h-11 items-center rounded-lg border border-black/15 bg-white px-3.5 transition-colors focus-within:border-black/50 dark:border-white/10 dark:bg-white/5 dark:focus-within:border-white/40">
        <input
          type={isPassword && showPassword ? 'text' : type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          disabled={disabled}
          required
          minLength={isPassword ? 6 : undefined}
          className="w-full bg-transparent text-sm text-black outline-none placeholder:text-black/30 disabled:cursor-wait disabled:opacity-60 dark:text-white dark:placeholder:text-white/30"
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            disabled={disabled}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="ml-2 shrink-0 text-black/40 transition-colors hover:text-black disabled:opacity-50 dark:text-white/40 dark:hover:text-white"
          >
            {showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
          </button>
        )}
      </div>
    </div>
  );
}

function CheckboxLine({ children }: { children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <span className="relative mt-1 size-3.5 shrink-0">
        <input
          type="checkbox"
          className="peer size-full cursor-pointer appearance-none rounded-[3px] border border-black/25 bg-white checked:border-black checked:bg-black dark:border-white/30 dark:bg-white/5 dark:checked:border-white dark:checked:bg-white"
        />
        <svg
          viewBox="0 0 12 12"
          className="pointer-events-none absolute inset-0 hidden size-full p-0.5 text-white peer-checked:block dark:text-black"
          fill="none"
          aria-hidden="true"
        >
          <path d="M3 6.2 5 8.1 9 3.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span>{children}</span>
    </label>
  );
}

function DashboardMockup() {
  return (
    <div className="grid min-h-[290px] grid-cols-[88px_1fr] bg-[#f5f7fb] text-left text-slate-900">
      <div className="hidden border-r border-slate-200 bg-[#101827] p-3 text-white sm:block">
        <div className="mb-7 h-2 w-12 rounded-full bg-white/80" />
        <div className="space-y-3 text-[8px] text-white/50">
          <div className="rounded bg-blue-500/80 px-2 py-1.5 text-white">Workspace</div>
          <div className="px-2">Candidates</div>
          <div className="px-2">Interviews</div>
          <div className="px-2">Onboarding</div>
        </div>
      </div>
      <div className="p-4 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="h-2.5 w-28 rounded-full bg-slate-800" />
            <div className="mt-2 h-1.5 w-40 rounded-full bg-slate-300" />
          </div>
          <div className="size-7 rounded-full bg-blue-200" />
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {['Open roles', 'Candidates', 'Interviews'].map((label, index) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
              <div className="text-[8px] text-slate-400">{label}</div>
              <div className="mt-2 h-3 w-10 rounded bg-slate-800" />
              <div className={`mt-3 h-1.5 rounded ${index === 1 ? 'w-4/5 bg-blue-500' : index === 2 ? 'w-3/5 bg-emerald-400' : 'w-2/3 bg-indigo-300'}`} />
            </div>
          ))}
        </div>
        <div className="mt-5 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="h-2 w-24 rounded-full bg-slate-700" />
            <div className="h-1.5 w-12 rounded-full bg-slate-200" />
          </div>
          <div className="mt-5 space-y-4">
            {[['w-2/5', 'w-4/5', 'bg-blue-500'], ['w-3/5', 'w-3/5', 'bg-emerald-400'], ['w-1/3', 'w-2/3', 'bg-violet-400']].map(([name, progress, color]) => (
              <div key={`${name}-${progress}`} className="flex items-center gap-3">
                <div className={`h-1.5 ${name} rounded-full bg-slate-200`} />
                <div className="h-1.5 flex-1 rounded-full bg-slate-100"><div className={`h-full ${progress} rounded-full ${color}`} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" fill="#34A853" />
      <path d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84Z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" fill="#EB4335" />
    </svg>
  );
}
