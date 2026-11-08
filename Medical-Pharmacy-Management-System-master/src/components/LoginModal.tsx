import React, { useState } from 'react';
import { api } from '../lib/api';
import { User } from '../types';
import { Pill, Shield, KeyRound, User as UserIcon, RefreshCw, Eye, EyeOff, Mail, CheckCircle2, ArrowRight } from 'lucide-react';

interface LoginModalProps {
  onLoginSuccess: (user: User) => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ onLoginSuccess }) => {
  const [loginMode, setLoginMode] = useState<'PASSWORD' | 'OTP'>('PASSWORD');

  // Password Login state
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);

  // OTP Login state
  const [otpEmail, setOtpEmail] = useState<string>('');
  const [otpCode, setOtpCode] = useState<string>('');
  const [otpSent, setOtpSent] = useState<boolean>(false);
  const [demoCodeNotice, setDemoCodeNotice] = useState<string | null>(null);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setLoading(true);
      const res = await api.login(username, password);
      onLoginSuccess(res.user);
    } catch (err: any) {
      setError(err.message || 'Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  const handleSendLoginOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpEmail) return;
    setError(null);
    setDemoCodeNotice(null);
    try {
      setLoading(true);
      const res = await api.sendLoginOtp(otpEmail);
      setOtpSent(true);
      if (res.otp_code) {
        setDemoCodeNotice(`Verification Code: ${res.otp_code}`);
        setOtpCode(res.otp_code);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to send OTP verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyLoginOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpEmail || !otpCode) return;
    setError(null);
    try {
      setLoading(true);
      const res = await api.loginWithOtp(otpEmail, otpCode);
      onLoginSuccess(res.user);
    } catch (err: any) {
      setError(err.message || 'Invalid or expired OTP code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 sm:p-8 shadow-2xl animate-fade-in relative overflow-hidden">
        
        {/* Decor */}
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-emerald-600/20 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-teal-600/20 rounded-full blur-3xl pointer-events-none"></div>

        <div className="text-center space-y-3 mb-6 relative z-10">
          <div className="mx-auto w-14 h-14 bg-gradient-to-br from-emerald-500 to-teal-700 rounded-2xl flex items-center justify-center shadow-lg transform rotate-3">
            <Pill className="w-7 h-7 text-white -rotate-3" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">Khushi Medical Hall</h2>
            <p className="text-emerald-400 font-medium text-xs mt-0.5 tracking-wide">Multi-Tenant Store POS v3.0</p>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-950 rounded-xl border border-slate-800 mb-6 relative z-10 text-xs font-bold">
          <button
            type="button"
            onClick={() => {
              setLoginMode('PASSWORD');
              setError(null);
            }}
            className={`py-2 rounded-lg transition-all ${
              loginMode === 'PASSWORD'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Password Login
          </button>
          <button
            type="button"
            onClick={() => {
              setLoginMode('OTP');
              setError(null);
            }}
            className={`py-2 rounded-lg transition-all ${
              loginMode === 'OTP'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Email OTP Login
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-rose-950/50 border border-rose-900/50 text-rose-300 text-xs rounded-xl text-center font-medium">
            {error}
          </div>
        )}

        {demoCodeNotice && (
          <div className="mb-4 p-2.5 bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-xs rounded-xl text-center flex items-center justify-center space-x-1.5 font-mono font-bold">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>{demoCodeNotice}</span>
          </div>
        )}

        {loginMode === 'PASSWORD' ? (
          <form onSubmit={handlePasswordLogin} className="space-y-4 relative z-10">
            <div>
              <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Username / Email</label>
              <div className="relative">
                <UserIcon className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter username or email"
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-950 text-white placeholder-slate-600 text-xs rounded-xl border border-slate-800 focus:outline-none focus:border-emerald-500 transition-all"
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Password</label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-10 pr-10 py-2.5 bg-slate-950 text-white placeholder-slate-600 text-xs rounded-xl border border-slate-800 focus:outline-none focus:border-emerald-500 transition-all font-mono"
                />
                <button 
                  type="button" 
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-2.5 text-slate-500 hover:text-emerald-400 focus:outline-none"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold py-3 rounded-xl text-xs flex items-center justify-center space-x-2 transition-all shadow-lg shadow-emerald-900/20 mt-6"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
              <span>Secure System Login</span>
            </button>
          </form>
        ) : (
          <div className="space-y-4 relative z-10">
            {!otpSent ? (
              <form onSubmit={handleSendLoginOtp} className="space-y-4">
                <div>
                  <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Registered Email Address</label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type="email"
                      required
                      value={otpEmail}
                      onChange={(e) => setOtpEmail(e.target.value)}
                      placeholder="user@example.com"
                      className="w-full pl-10 pr-4 py-2.5 bg-slate-950 text-white placeholder-slate-600 text-xs rounded-xl border border-slate-800 focus:outline-none focus:border-emerald-500 transition-all"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl text-xs flex items-center justify-center space-x-2 transition-all shadow-lg"
                >
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  <span>Send Login Verification OTP</span>
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyLoginOtp} className="space-y-4">
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-300 flex justify-between items-center">
                  <div>
                    <span className="text-slate-500 block text-[10px]">OTP Sent To:</span>
                    <strong className="text-white">{otpEmail}</strong>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOtpSent(false)}
                    className="text-emerald-400 hover:underline text-[10px]"
                  >
                    Change Email
                  </button>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Enter 6-Digit OTP Code</label>
                  <input
                    type="text"
                    required
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    placeholder="123456"
                    className="w-full tracking-widest text-center text-lg font-mono font-bold py-2.5 bg-slate-950 text-emerald-400 placeholder-slate-700 rounded-xl border border-slate-800 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold py-3 rounded-xl text-xs flex items-center justify-center space-x-2 transition-all shadow-lg shadow-emerald-900/20"
                >
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                  <span>Verify OTP & Login</span>
                </button>
              </form>
            )}
          </div>
        )}
        
        <div className="mt-6 text-center text-[10px] text-slate-500 font-medium">
          Protected by AES-256 Multi-Tenant Security & OTP Verification
        </div>
      </div>
    </div>
  );
};
