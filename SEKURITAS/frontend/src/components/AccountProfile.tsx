import { useEffect } from 'react';
import { CreditCard, Landmark, UserRound } from 'lucide-react';
import { useStore } from '../store/useStore';

export default function AccountProfile() {
  const profile = useStore(state => state.accountProfile);
  const fetchAccountProfile = useStore(state => state.fetchAccountProfile);

  useEffect(() => {
    fetchAccountProfile();
  }, [fetchAccountProfile]);

  return (
    <section className="glass-panel dashboard-panel">
      <div className="panel-title">
        <UserRound className="text-primary" size={20} />
        <h3>Account Profile</h3>
      </div>
      {!profile ? (
        <p>Account references are not available.</p>
      ) : (
        <div className="metric-grid">
          <div className="metric-block">
            <span>SID</span>
            <strong>{profile.references.sid || '-'}</strong>
          </div>
          <div className="metric-block">
            <span>SRE</span>
            <strong>{profile.references.sre || '-'}</strong>
          </div>
          <div className="metric-block">
            <span>RDN</span>
            <strong>{profile.references.rdn || '-'}</strong>
          </div>
          <div className="metric-block">
            <span>Status</span>
            <strong>{profile.account.status}</strong>
          </div>
        </div>
      )}
      <div className="inline-note">
        <Landmark size={16} />
        <span>Broker account</span>
        <strong>{profile?.account.account_type || '-'}</strong>
        <CreditCard size={16} />
      </div>
    </section>
  );
}
