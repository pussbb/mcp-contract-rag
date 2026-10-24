namespace Fixture.Domain
{
    /// <summary>Base class for repositories.</summary>
    public abstract class Repository<T> : IRepository<T> where T : class
    {
        public string Name { get; protected set; } = "";
        protected Repository(string name) { Name = name; }
        public abstract Task<T?> FindAsync(Guid id);
        public virtual void Save(T item) { }
        private void Internal() { }
    }

    public interface IRepository<T>
    {
        Task<T?> FindAsync(Guid id);
    }

    [Obsolete]
    public enum Status { Open, Closed }

    public record Invoice(Guid Id, decimal Total);
}
