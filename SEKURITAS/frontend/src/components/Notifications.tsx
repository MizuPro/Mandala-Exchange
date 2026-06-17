import { useEffect } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { useStore } from '../store/useStore';

export default function Notifications() {
  const notifications = useStore(state => state.notifications);
  const fetchNotifications = useStore(state => state.fetchNotifications);
  const markNotificationRead = useStore(state => state.markNotificationRead);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const unread = notifications.filter(item => !item.read_at).length;

  return (
    <section className="glass-panel dashboard-panel">
      <div className="panel-title">
        <Bell className="text-warning" size={20} />
        <h3>Notifications</h3>
        {unread > 0 && <span className="badge">{unread}</span>}
      </div>
      {notifications.length === 0 ? (
        <p>No notifications.</p>
      ) : (
        <div className="stack-list compact-list">
          {notifications.slice(0, 6).map(item => (
            <div key={item.id} className={`list-row ${item.read_at ? '' : 'unread-row'}`}>
              <div>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
                <span className="text-muted">{new Date(item.created_at).toLocaleString()}</span>
              </div>
              {!item.read_at && (
                <button
                  type="button"
                  className="icon-button"
                  title="Mark as read"
                  onClick={() => markNotificationRead(item.id)}
                >
                  <CheckCheck size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
