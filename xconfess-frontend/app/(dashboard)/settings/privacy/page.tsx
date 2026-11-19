"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Bell,
  BellOff,
  Database,
  Eye,
  EyeOff,
  ExternalLink,
  Globe,
  Info,
  Laptop,
  Layers,
  Lock,
  MessageSquare,
  Moon,
  RotateCcw,
  Save,
  Shield,
  Sun,
} from 'lucide-react';
import { useGlobalToast } from '@/app/components/common/Toast';
import StepUpModal from '@/app/components/admin/StepUpModal';
import { useStepUp } from '@/app/hooks/useStepUp';
import { normalizeApiError } from '@/app/lib/api/errors';
import { stepUpHeader } from '@/app/lib/api/stepUp';
import { useTheme } from '@/app/lib/hooks/useTheme';
import {
  mergePrivacySettingsAfterConflict,
  PRIVACY_SETTING_KEYS,
  type PrivacySettings,
} from '@/app/lib/utils/privacySettings';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id: string;
}

function ToggleSwitch({ checked, onChange, id }: ToggleProps) {
  return (
    <button
      id={id}
      role="switch"
      type="button"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-gray-900 ${
        checked ? 'bg-purple-600' : 'bg-gray-600'
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export type DataFlowCategory = 'identity' | 'content' | 'analytics' | 'notifications';

export interface PrivacyControlConfig {
  key: keyof PrivacySettings;
  dataFlow: DataFlowCategory;
  flowTitle: string;
  label: string;
  description: string;
  effect: string;
  affectedProductSurface: string;
  affectedProductHref: string;
  icon: React.ReactNode;
  iconOff?: React.ReactNode;
}

const TOGGLE_CONFIGS: PrivacyControlConfig[] = [
  {
    key: 'isDiscoverable',
    dataFlow: 'identity',
    flowTitle: 'Identity & Discovery Data Flow',
    label: 'Profile Discovery',
    description: 'Allow others to find your profile in search and the user directory.',
    effect: 'When off, your profile is hidden from search results and the public directory. Direct links to your profile will still work.',
    affectedProductSurface: 'Public Search & Directory (/search)',
    affectedProductHref: '/search',
    icon: <Globe className="h-5 w-5 text-purple-400" />,
    iconOff: <Lock className="h-5 w-5 text-gray-500" />,
  },
  {
    key: 'canReceiveReplies',
    dataFlow: 'content',
    flowTitle: 'Content & Interaction Data Flow',
    label: 'Allow Replies',
    description: 'Let other users reply to your confessions.',
    effect: 'When off, the reply button is disabled on all your confessions. Existing replies remain visible.',
    affectedProductSurface: 'Confession Discussions (/confessions)',
    affectedProductHref: '/confessions',
    icon: <MessageSquare className="h-5 w-5 text-blue-400" />,
  },
  {
    key: 'showReactions',
    dataFlow: 'content',
    flowTitle: 'Content & Interaction Data Flow',
    label: 'Show Reactions',
    description: 'Display emoji reactions on your confessions.',
    effect: 'When off, reaction counts and buttons are hidden on your confessions. Others can still react, but counts are not shown.',
    affectedProductSurface: 'Feed & Reaction Display (/)',
    affectedProductHref: '/',
    icon: <Bell className="h-5 w-5 text-yellow-400" />,
    iconOff: <BellOff className="h-5 w-5 text-gray-500" />,
  },
  {
    key: 'contentWarningsCollapsed',
    dataFlow: 'content',
    flowTitle: 'Content & Interaction Data Flow',
    label: 'Collapse Sensitive Content Warnings',
    description: 'Choose whether posts with sensitive-content warnings start collapsed.',
    effect: 'When on, warned posts stay hidden until you explicitly reveal them. When off, warned posts display normally.',
    affectedProductSurface: 'Confession Feed (/)',
    affectedProductHref: '/',
    icon: <Shield className="h-5 w-5 text-amber-400" />,
    iconOff: <Eye className="h-5 w-5 text-gray-500" />,
  },
  {
    key: 'dataProcessingConsent',
    dataFlow: 'analytics',
    flowTitle: 'Analytics & Service Telemetry Data Flow',
    label: 'Data Processing Consent',
    description: 'Allow processing of your data for service improvement and analytics.',
    effect: 'When off, your usage data is excluded from analytics aggregation. Core functionality is not affected.',
    affectedProductSurface: 'Activity Analytics & Telemetry (/analytics)',
    affectedProductHref: '/analytics',
    icon: <Database className="h-5 w-5 text-green-400" />,
  },
];

const DATA_FLOW_GROUPS: {
  id: DataFlowCategory;
  title: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    id: 'identity',
    title: 'Identity & Discovery Data Flow',
    description: 'Governs how your account identity, profile metadata, and search presence propagate across the platform.',
    icon: <Globe className="h-5 w-5 text-purple-400" />,
  },
  {
    id: 'content',
    title: 'Content & Interaction Data Flow',
    description: 'Determines whether other community members can respond, reply, or attach reactions to your confessions.',
    icon: <MessageSquare className="h-5 w-5 text-blue-400" />,
  },
  {
    id: 'analytics',
    title: 'Analytics & Service Telemetry Data Flow',
    description: 'Controls telemetry aggregation and anonymized performance metrics.',
    icon: <Database className="h-5 w-5 text-green-400" />,
  },
];

const THEME_OPTIONS: { key: 'light' | 'dark' | 'system'; label: string; icon: React.ReactNode }[] = [
  { key: 'light', label: 'Light', icon: <Sun className="h-4 w-4" /> },
  { key: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" /> },
  { key: 'system', label: 'System', icon: <Laptop className="h-4 w-4" /> },
];

export default function PrivacySettingsPage() {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<PrivacySettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<PrivacySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const savedSettingsRef = useRef<PrivacySettings | null>(null);
  const saveInFlightRef = useRef(false);
  const toast = useGlobalToast();
  const stepUp = useStepUp();

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch('/api/users/privacy-settings', {
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await normalizeApiError(response);
        throw new Error(error.message);
      }

      const data: PrivacySettings = await response.json();
      savedSettingsRef.current = data;
      setSettings(data);
      setSavedSettings(data);
      setDirty(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load privacy settings.';
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleToggle = (key: keyof PrivacySettings, value: boolean) => {
    if (!settings) return;
    const nextSettings = { ...settings, [key]: value };
    setSettings(nextSettings);

    if (savedSettings) {
      const isChanged = Object.keys(nextSettings).some(
        (k) => nextSettings[k as keyof PrivacySettings] !== savedSettings[k as keyof PrivacySettings],
      );
      setDirty(isChanged);
    } else {
      setDirty(true);
    }
  };

  const handleDiscard = () => {
    if (savedSettings) {
      setSettings({ ...savedSettings });
      setDirty(false);
    }
  };

  const persistSettings = async (stepUpToken: string) => {
    if (!settings || saveInFlightRef.current) return;

    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const response = await fetch('/api/users/privacy-settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...stepUpHeader(stepUpToken),
        },
        credentials: 'include',
        body: JSON.stringify(settings),
      });

      if (!response.ok) {
        const error = await normalizeApiError(response);
        if (error.status === 409) {
          const refreshResponse = await fetch('/api/users/privacy-settings', {
            credentials: 'include',
          });

          if (!refreshResponse.ok) {
            const refreshError = await normalizeApiError(refreshResponse);
            throw new Error(refreshError.message || error.message);
          }

          const serverSettings: PrivacySettings = await refreshResponse.json();
          const baseline = savedSettingsRef.current ?? settings;
          const mergedSettings = mergePrivacySettingsAfterConflict(
            settings,
            baseline,
            serverSettings,
          );
          savedSettingsRef.current = serverSettings;
          setSettings(mergedSettings);
          setDirty(
            PRIVACY_SETTING_KEYS.some(
              (key) => mergedSettings[key] !== serverSettings[key],
            ),
          );
          toast.error('Settings changed elsewhere. Your edits were preserved; review and save again.');
          return;
        }
        throw new Error(error.message);
      }

      const updated: PrivacySettings = await response.json();
      if (typeof updated.contentWarningsCollapsed === 'boolean') {
        window.localStorage.setItem(
          'contentWarningsCollapsed',
          String(updated.contentWarningsCollapsed),
        );
      }
      savedSettingsRef.current = updated;
      setSettings(updated);
      setSavedSettings(updated);
      setDirty(false);
      toast.success('Privacy settings saved successfully');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save privacy settings');
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (!settings || saveInFlightRef.current) return;
    stepUp.requestStepUp((token) => {
      void persistSettings(token);
    });
  };

  // Calculate effective security posture summary
  const effectivePosture = useMemo(() => {
    if (!settings) return { label: 'Standard', color: 'text-purple-400' };
    const enabledCount = Object.values(settings).filter(Boolean).length;
    if (enabledCount <= 1) {
      return { label: 'Maximum Privacy', color: 'text-emerald-400', desc: 'Minimal exposure; discoverability and telemetry minimized.' };
    }
    if (enabledCount >= 3) {
      return { label: 'Open Engagement', color: 'text-blue-400', desc: 'Full community participation, search indexing, and reaction visibility.' };
    }
    return { label: 'Balanced Protection', color: 'text-purple-400', desc: 'Standard platform defaults preserving core interactions.' };
  }, [settings]);

  // Compute pending change diffs
  const pendingChanges = useMemo(() => {
    if (!settings || !savedSettings) return [];
    return TOGGLE_CONFIGS.filter(
      (c) => settings[c.key] !== savedSettings[c.key],
    ).map((c) => ({
      label: c.label,
      from: savedSettings[c.key],
      to: settings[c.key],
    }));
  }, [settings, savedSettings]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600" />
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="bg-red-900/20 border border-red-800 rounded-xl p-6 text-center">
          <p className="text-red-200 mb-4">{loadError ?? 'Failed to load privacy settings.'}</p>
          <button
            onClick={loadSettings}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* Page Title & Effective Overview */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Shield className="w-8 h-8 text-purple-500" />
          Privacy Settings
        </h1>
        <p className="text-gray-400 mt-1">
          Control your visibility, interactions, and data preferences. Each setting maps directly to how your profile behaves across the platform.
        </p>
      </div>

      {/* Unified Effective State & Data Flow Summary Card */}
      <div className="mb-6 rounded-xl border border-purple-500/30 bg-purple-950/20 p-5 shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-purple-400" />
              <h2 className="text-lg font-semibold text-white">
                Effective Privacy Posture: <span className={effectivePosture.color}>{effectivePosture.label}</span>
              </h2>
            </div>
            <p className="text-sm text-gray-300">{effectivePosture.desc}</p>
          </div>

          <div className="flex items-center gap-2">
            {dirty ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/20 px-3 py-1 text-xs font-medium text-yellow-300 border border-yellow-500/30">
                <Info className="h-3.5 w-3.5" />
                {pendingChanges.length} pending {pendingChanges.length === 1 ? 'change' : 'changes'}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/20 px-3 py-1 text-xs font-medium text-green-300 border border-green-500/30">
                <Shield className="h-3.5 w-3.5" />
                Effective state saved
              </span>
            )}
          </div>
        </div>

        {/* Pending Change Diffs */}
        {dirty && pendingChanges.length > 0 && (
          <div className="mt-4 border-t border-purple-500/20 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-purple-300 mb-2">
              Pending Changes Diff:
            </p>
            <div className="flex flex-wrap gap-2">
              {pendingChanges.map((change) => (
                <span
                  key={change.label}
                  className="inline-flex items-center gap-1 text-xs bg-gray-800 text-gray-200 border border-gray-700 rounded-md px-2.5 py-1"
                >
                  <span className="font-medium text-white">{change.label}:</span>
                  <span className={change.from ? 'text-green-400' : 'text-gray-400'}>
                    {change.from ? 'Enabled' : 'Disabled'}
                  </span>
                  <ArrowRight className="h-3 w-3 text-gray-500" />
                  <span className={change.to ? 'text-green-400 font-semibold' : 'text-yellow-400 font-semibold'}>
                    {change.to ? 'Enabled' : 'Disabled'}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Privacy Controls Grouped by Data Flow */}
      {DATA_FLOW_GROUPS.map((group) => {
        const groupConfigs = TOGGLE_CONFIGS.filter((c) => c.dataFlow === group.id);
        if (groupConfigs.length === 0) return null;

        return (
          <div key={group.id} className="bg-gray-800 rounded-lg mb-6 border border-gray-700/60 overflow-hidden">
            <div className="p-4 border-b border-gray-700 bg-gray-800/80">
              <h2 className="font-semibold text-white flex items-center gap-2">
                {group.icon}
                {group.title}
              </h2>
              <p className="text-sm text-gray-400 mt-0.5">
                {group.description}
              </p>
            </div>

            <div className="divide-y divide-gray-700">
              {groupConfigs.map((config) => {
                const isOn = settings[config.key];
                const savedVal = savedSettings ? savedSettings[config.key] : isOn;
                const isPending = isOn !== savedVal;

                return (
                  <div key={config.key} className="p-4 transition-colors hover:bg-gray-750">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="mt-0.5 flex-shrink-0">
                          {isOn ? config.icon : config.iconOff ?? config.icon}
                        </div>
                        <div className="min-w-0">
                          <label
                            htmlFor={`toggle-${config.key}`}
                            className="font-medium text-white cursor-pointer"
                          >
                            {config.label}
                          </label>
                          <p className="text-sm text-gray-400 mt-0.5">{config.description}</p>
                          <p className="text-xs text-gray-500 mt-1 italic">{config.effect}</p>

                          {/* Link to Affected Product Behavior */}
                          <div className="mt-2.5 flex flex-wrap items-center gap-2">
                            <span className="text-xs text-gray-400">Affected Surface:</span>
                            <Link
                              href={config.affectedProductHref}
                              className="inline-flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 underline underline-offset-2"
                            >
                              {config.affectedProductSurface}
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          </div>
                        </div>
                      </div>

                      <div className="flex-shrink-0 pt-0.5 flex flex-col items-end gap-2">
                        <ToggleSwitch
                          id={`toggle-${config.key}`}
                          checked={isOn}
                          onChange={(val) => handleToggle(config.key, val)}
                        />
                      </div>
                    </div>

                    {/* Effective State Feedback & Pending Status */}
                    <div className="ml-8 mt-2.5 flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                          isOn ? 'bg-green-900/50 text-green-400' : 'bg-gray-700 text-gray-400'
                        }`}
                      >
                        {isOn ? (<><Eye className="h-3 w-3" /> Enabled</>) : (<><EyeOff className="h-3 w-3" /> Disabled</>)}
                      </span>

                      {isPending && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-yellow-900/40 border border-yellow-700/50 px-2 py-0.5 text-xs font-medium text-yellow-300">
                          Pending change (Unsaved)
                        </span>
                      )}

                      <span className="text-xs text-gray-500">
                        Saved: {savedVal ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Cross-Surface Notifications Data Flow Integration */}
      <div className="bg-gray-800 rounded-lg mb-6 border border-gray-700/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="font-semibold text-white flex items-center gap-2">
              <Bell className="h-5 w-5 text-yellow-400" />
              Notification & Communication Data Flow
            </h2>
            <p className="text-sm text-gray-400">
              Manage multi-channel delivery rules (In-App, Email, Push) and Quiet Hours privacy schedules.
            </p>
          </div>
          <Link
            href="/settings/notifications"
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 px-3 py-2 text-xs font-medium text-white transition-colors"
          >
            Manage notification preferences
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      {/* Appearance Section */}
      <div className="bg-gray-800 rounded-lg mb-6 p-4 border border-gray-700/60">
        <h2 className="font-semibold text-white mb-3">Appearance</h2>
        <div className="flex gap-2">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setTheme(opt.key)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                theme === opt.key ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
          {dirty && (
            <button
              type="button"
              onClick={handleDiscard}
              disabled={saving}
              className="px-4 py-2.5 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-750 text-gray-300 hover:text-white flex items-center justify-center gap-2 transition-colors font-medium text-sm"
            >
              <RotateCcw className="h-4 w-4" />
              Discard Changes
            </button>
          )}

          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2.5 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors font-medium text-sm shadow-md"
          >
            {saving ? 'Saving...' : (<><Save className="h-5 w-5" /> Save Privacy Settings</>)}
          </button>
        </div>

        {dirty && (
          <p className="text-center text-xs text-yellow-500 mt-2">
            You have unsaved changes.
          </p>
        )}
      </div>
      <StepUpModal
        isOpen={stepUp.isModalOpen}
        onVerify={stepUp.verify}
        onCancel={stepUp.cancel}
        error={stepUp.error}
        isVerifying={stepUp.isVerifying}
      />
    </div>
  );
}
