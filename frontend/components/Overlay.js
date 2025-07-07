import styles from '../styles/Home.module.css';

export default function Overlay({ message }) {
    if (!message) return [];

    return (
        <div className={styles.overlay}>
            <div className={styles.message}>
                {message.text}
                {!message.success && (
                    <div className={styles.spinnerContainer}>
                        <img 
                            src="/shade-agent.svg" 
                            alt="Loading..." 
                            className={styles.spinningLogo}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
