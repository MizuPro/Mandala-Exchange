import { useEffect } from 'react';
import { Trophy } from 'lucide-react';
import { useStore } from '../store/useStore';

const formatIDR = (value: number) =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(value || 0);

export default function Leaderboard() {
  const leaderboard = useStore(state => state.leaderboard);
  const fetchLeaderboard = useStore(state => state.fetchLeaderboard);

  useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  const rows = leaderboard?.rankings || [];

  return (
    <section className="glass-panel dashboard-panel">
      <div className="panel-title">
        <Trophy className="text-warning" size={20} />
        <h3>Leaderboard</h3>
      </div>
      {rows.length === 0 ? (
        <p>No ranking data.</p>
      ) : (
        <div className="table-wrapper dense-table">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Account</th>
                <th>NAV</th>
                <th>Return</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((row: any) => (
                <tr key={row.broker_account_id}>
                  <td>{row.rank}</td>
                  <td>{row.display_name}</td>
                  <td>{formatIDR(row.nav)}</td>
                  <td className={row.return_pct >= 0 ? 'text-success' : 'text-danger'}>
                    {(row.return_pct * 100).toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
